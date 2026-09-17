import { NodeFileSystem } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Console, Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect"
import { Command } from "effect/unstable/cli"
import type { ChildProcess } from "effect/unstable/process"

import { ConfigStore } from "#adapters/config.ts"
import { key, layerScripted } from "#adapters/picker.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"
import * as Store from "#adapters/store.ts"
import { dwMc, version } from "#cli/cli.ts"

/** Everything `dw-mc cleanup` runs on: a real state directory, and a `git` that only prunes. */
const machine = (options: {
  readonly home: string
  readonly spawned: Array<ChildProcess.StandardCommand>
  readonly keys?: ReadonlyArray<Terminal.UserInput> | undefined
}) => {
  const spawner = layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("cleanup.test: the fake was handed a piped command")
    }
    options.spawned.push(command)
    return Effect.succeed(fakeHandle({}))
  })

  return Layer.provideMerge(
    Layer.mergeAll(ConfigStore.layerTest, Store.layerTest),
    Layer.mergeAll(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          HOME: options.home,
          XDG_STATE_HOME: options.home,
          XDG_CONFIG_HOME: options.home
        })
      ),
      NodeFileSystem.layer,
      Path.layer,
      Stdio.layerTest({}),
      spawner,
      layerScripted(options.keys ?? [])
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

/** Writes one file, and every directory above it. */
const put = Effect.fnUntraced(function* (file: string, contents: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* fs.writeFileString(file, contents)
})

/** A temporary machine, and where everything the tool writes sits inside it. */
const laidOut = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* fs.makeTempDirectoryScoped()
  const state = path.join(home, "dw-mc")

  return {
    home,
    state,
    clone: path.join(state, "repos", "dw", "one.git"),
    worktree: path.join(state, "worktrees", "dw", "one", "28"),
    fix: path.join(state, "fixes", "dw", "one", "28"),
    record: path.join(state, "prs%2Fdw%2Fone%2328")
  }
})

describe("dw-mc cleanup", () => {
  it.effect("takes the clone and the review worktree, and leaves the records alone", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const at = yield* laidOut()
      yield* put(path.join(at.clone, "HEAD"), "ref: refs/heads/main\n")
      yield* put(path.join(at.worktree, "README.md"), "cut for a review run\n")
      yield* put(at.record, `{"number":28}`)

      yield* run("cleanup", "--yes").pipe(Effect.provide(machine({ home: at.home, spawned })), recording(printed))

      assert.isFalse(yield* fs.exists(at.clone))
      assert.isFalse(yield* fs.exists(at.worktree))
      assert.isTrue(yield* fs.exists(at.record))
      assert.include(printed.join("\n"), "a bare clone, cloned again on the next run")
      assert.include(printed.join("\n"), "a review worktree a run left behind")
      assert.isTrue(printed.at(-1)?.startsWith("Took back "))

      // What is left is the state directory itself and the record in it, with
      // none of the directories the clone and the worktree were spelled out in.
      assert.deepStrictEqual(yield* fs.readDirectory(at.state), ["prs%2Fdw%2Fone%2328"])
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer)))
  })

  it.effect("leaves the clone a fix session stands on, and prunes it instead", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const at = yield* laidOut()
      yield* put(path.join(at.clone, "HEAD"), "ref: refs/heads/main\n")
      yield* put(path.join(at.worktree, "README.md"), "cut for a review run\n")
      yield* put(path.join(at.fix, "README.md"), "cut for a fix session\n")

      yield* run("cleanup", "--yes").pipe(Effect.provide(machine({ home: at.home, spawned })), recording(printed))

      assert.isTrue(yield* fs.exists(at.clone))
      assert.isTrue(yield* fs.exists(at.fix))
      assert.isFalse(yield* fs.exists(at.worktree))
      assert.include(printed.join("\n"), "a fix session stands on dw/one#28")
      assert.deepStrictEqual(
        spawned.map((command) => `${command.command} ${command.args.join(" ")}`),
        [`git -C ${at.clone} worktree prune`]
      )
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer)))
  })

  it.effect("removes nothing when the confirmation is answered with no", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const at = yield* laidOut()
      yield* put(path.join(at.clone, "HEAD"), "ref: refs/heads/main\n")

      yield* run("cleanup").pipe(
        Effect.provide(machine({ home: at.home, spawned, keys: [key("n")] })),
        recording(printed)
      )

      assert.isTrue(yield* fs.exists(at.clone))
      assert.strictEqual(printed.at(-1), "Nothing was removed.")
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer)))
  })

  it.effect("says there is nothing to take back on a machine that has run nothing", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const at = yield* laidOut()

      yield* run("cleanup", "--yes").pipe(Effect.provide(machine({ home: at.home, spawned })), recording(printed))

      assert.deepStrictEqual(printed, [`Nothing to take back in ${at.state}.`])
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer)))
  })
})
