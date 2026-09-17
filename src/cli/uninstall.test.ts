import { NodeFileSystem } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Console, Effect, FileSystem, Layer, Path, Stdio } from "effect"
import { Command } from "effect/unstable/cli"
import type { ChildProcess } from "effect/unstable/process"

import { ConfigStore } from "#adapters/config.ts"
import { layerScripted } from "#adapters/picker.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"
import * as Store from "#adapters/store.ts"
import { dwMc, version } from "#cli/cli.ts"

/** What the clone says about the fix branch: nothing at all, or a head and a count. */
interface Branch {
  readonly changes?: string | undefined
  readonly at?: string | undefined
  readonly pullRequest?: string | undefined
  readonly ahead?: number | undefined
}

const head = "284d599022a55d4dcae74b31b9a49a0f50061014"

/**
 * Everything `dw-mc uninstall` runs on: a real state directory, and a `git`
 * answering for one fix branch.
 */
const machine = (options: {
  readonly home: string
  readonly config?: string | undefined
  readonly spawned: Array<ChildProcess.StandardCommand>
  readonly branch?: Branch | undefined
}) => {
  const branch = options.branch ?? {}
  const spawner = layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("uninstall.test: the fake was handed a piped command")
    }
    options.spawned.push(command)
    const argv = command.args.join(" ")

    if (argv.endsWith("status --porcelain")) {
      return Effect.succeed(fakeHandle({ stdout: branch.changes ?? "" }))
    }
    if (argv.endsWith("rev-parse --verify --quiet refs/heads/dw-mc/fix/28")) {
      return branch.at === undefined
        ? Effect.succeed(fakeHandle({ exitCode: 1 }))
        : Effect.succeed(fakeHandle({ stdout: `${branch.at}\n` }))
    }
    if (argv.endsWith("rev-parse refs/dw-mc/pr/28")) {
      return branch.pullRequest === undefined
        ? Effect.succeed(fakeHandle({ exitCode: 1, stderr: "fatal: bad revision\n" }))
        : Effect.succeed(fakeHandle({ stdout: `${branch.pullRequest}\n` }))
    }
    if (argv.includes("rev-list --count")) {
      return Effect.succeed(fakeHandle({ stdout: `${branch.ahead ?? 0}\n` }))
    }
    return Effect.succeed(fakeHandle({}))
  })

  return Layer.provideMerge(
    Layer.mergeAll(ConfigStore.layerTest, Store.layerTest),
    Layer.mergeAll(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          HOME: options.home,
          XDG_STATE_HOME: options.home,
          XDG_CONFIG_HOME: `${options.home}/config`
        })
      ),
      NodeFileSystem.layer,
      Path.layer,
      Stdio.layerTest({}),
      spawner,
      layerScripted([])
    )
  )
}

const recording = (printed: Array<string>) => {
  const console_: Console.Console = Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
    error: () => {}
  })
  return Effect.provideService(Console.Console, console_)
}

const run = (...argv: ReadonlyArray<string>) => Command.runWith(dwMc, { version })(argv)

const put = Effect.fnUntraced(function* (file: string, contents: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* fs.writeFileString(file, contents)
})

/** A machine that has swept, reviewed, and opened one fix session. */
const used = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* fs.makeTempDirectoryScoped()
  const state = path.join(home, "dw-mc")
  const at = {
    home,
    state,
    config: path.join(home, "config", "dw-mc", "config.yaml"),
    clone: path.join(state, "repos", "dw", "one.git"),
    fix: path.join(state, "fixes", "dw", "one", "28"),
    record: path.join(state, "prs%2Fdw%2Fone%2328")
  }

  yield* put(path.join(at.clone, "HEAD"), "ref: refs/heads/main\n")
  yield* put(path.join(at.fix, "README.md"), "cut for a fix session\n")
  yield* put(at.record, `{"number":28}`)
  return at
})

describe("dw-mc uninstall", () => {
  it.effect("takes the whole state directory and leaves the configuration file", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const at = yield* used()
      yield* put(at.config, "defaults:\n  review:\n    runners: [builtin]\n")

      yield* run("uninstall", "--yes").pipe(Effect.provide(machine({ home: at.home, spawned })), recording(printed))

      assert.isFalse(yield* fs.exists(at.state))
      assert.isTrue(yield* fs.exists(at.config))
      assert.include(printed.join("\n"), "every record, report, clone and worktree")
      assert.include(printed.join("\n"), `The configuration file stays at ${at.config}.`)
      assert.strictEqual(printed.at(-1), "Run pnpm remove -g dw-mc to take the binary, which is all that is left.")
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer)))
  })

  it.effect("takes the configuration file too where --config asks for it", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const at = yield* used()
      yield* put(at.config, "defaults: {}\n")

      yield* run("uninstall", "--config", "--yes").pipe(
        Effect.provide(machine({ home: at.home, spawned })),
        recording(printed)
      )

      assert.isFalse(yield* fs.exists(at.state))
      assert.isFalse(yield* fs.exists(at.config))
      assert.include(printed.join("\n"), "the runner and every repository registered")
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer)))
  })

  it.effect("removes nothing while a fix session holds a commit the pull request does not have", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const at = yield* used()

      yield* run("uninstall", "--yes").pipe(
        Effect.provide(machine({ home: at.home, spawned, branch: { at: head, pullRequest: head, ahead: 2 } })),
        recording(printed)
      )

      assert.isTrue(yield* fs.exists(at.state))
      assert.include(printed.join("\n"), "2 commits that the pull request's head does not have")
      assert.strictEqual(
        printed.at(-1),
        "Nothing was removed. Push that work or drop it, or run this again with --force."
      )
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer)))
  })

  it.effect("removes nothing while a fix session holds changes that are not committed", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const at = yield* used()

      yield* run("uninstall", "--yes").pipe(
        Effect.provide(machine({ home: at.home, spawned, branch: { changes: " M src/cli/fix.ts\n" } })),
        recording(printed)
      )

      assert.isTrue(yield* fs.exists(at.state))
      assert.include(printed.join("\n"), "changes that are not committed")
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer)))
  })

  it.effect("holds a session whose clone can no longer say what the pull request points at", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const at = yield* used()

      yield* run("uninstall", "--yes").pipe(
        Effect.provide(machine({ home: at.home, spawned, branch: { at: head } })),
        recording(printed)
      )

      assert.isTrue(yield* fs.exists(at.state))
      assert.include(printed.join("\n"), "so what dw-mc/fix/28 holds cannot be told")
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer)))
  })

  it.effect("takes a held session once --force says so", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const at = yield* used()

      yield* run("uninstall", "--force", "--yes").pipe(
        Effect.provide(machine({ home: at.home, spawned, branch: { at: head, pullRequest: head, ahead: 2 } })),
        recording(printed)
      )

      assert.isFalse(yield* fs.exists(at.state))
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer)))
  })

  it.effect("is not an error on a machine that has never run the tool", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()

      yield* run("uninstall", "--yes").pipe(Effect.provide(machine({ home, spawned })), recording(printed))

      assert.strictEqual(printed.at(-1), "Run pnpm remove -g dw-mc to take the binary, which is all that is left.")
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer)))
  })
})
