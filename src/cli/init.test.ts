import { NodeFileSystem } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import type { Config, Layer } from "effect"
import { ConfigProvider, Console, Effect, FileSystem, Option, Path, PlatformError, Stdio } from "effect"
import * as Layer_ from "effect/Layer"
import { Command } from "effect/unstable/cli"
import type { KeyValueStore } from "effect/unstable/persistence"
import type { ChildProcessSpawner } from "effect/unstable/process"

import type { ConfigFile } from "#adapters/config.ts"
import { ConfigStore, read, settingsFor, write } from "#adapters/config.ts"
import { key, layerScripted } from "#adapters/picker.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"
import * as Store from "#adapters/store.ts"
import { dwMc, version } from "#cli/cli.ts"

/** What the real `gh` says, captured from `gh` itself. */
const said = {
  loggedIn: "github.com\n  ✓ Logged in to github.com account dominikwozniak (keyring)\n",
  loggedOut: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n",
  repo: `{"nameWithOwner":"dominikwozniak/dw-mc"}\n`,
  noRepo: "failed to run git: fatal: not a git repository (or any of the parent directories): .git\n"
}

/** A `gh` that answers `auth status` and `repo view` from those fixtures. */
const gh = (options: { readonly auth?: string | undefined; readonly repo?: string | undefined }) =>
  layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("init.test: the fake was handed a piped command")
    }
    const argv = command.args.join(" ")
    if (argv === "auth status") {
      return Effect.succeed(
        options.auth === undefined
          ? fakeHandle({ exitCode: 1, stderr: said.loggedOut })
          : fakeHandle({ stdout: options.auth })
      )
    }
    if (argv === "repo view --json nameWithOwner") {
      return Effect.succeed(
        options.repo === undefined
          ? fakeHandle({ exitCode: 1, stderr: said.noRepo })
          : fakeHandle({ stdout: options.repo })
      )
    }
    return Effect.die(`init.test: nothing stubbed for '${command.command} ${argv}'`)
  })

const ghMissing = layerFake(() =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      description: "spawn gh ENOENT"
    })
  )
)

type StateLayer = Layer.Layer<
  KeyValueStore.KeyValueStore,
  Config.ConfigError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
>

/**
 * Everything `dw-mc init` runs on, and nothing else: one fake spawn for `gh`,
 * a terminal that answers with `keys`, an in-memory configuration file and an
 * in-memory state directory.
 */
const machine = (options: {
  readonly spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>
  readonly keys?: ReadonlyArray<ReturnType<typeof key>> | undefined
  readonly env?: Record<string, string | undefined> | undefined
  readonly fileSystem?: Layer.Layer<FileSystem.FileSystem> | undefined
  readonly state?: StateLayer | undefined
}) =>
  Layer_.provideMerge(
    Layer_.mergeAll(ConfigStore.layerTest, options.state ?? Store.layerTest),
    Layer_.mergeAll(
      ConfigProvider.layer(ConfigProvider.fromEnvRecord(options.env ?? { HOME: "/home/dw" })),
      options.fileSystem ?? FileSystem.layerNoop({}),
      Path.layer,
      Stdio.layerTest({}),
      options.spawner,
      layerScripted(options.keys ?? [])
    )
  )

/**
 * Collects what the command printed, so a test can read the table it wrote.
 *
 * `Console` is a `Context.Reference` Effect means to be overridden this way, so
 * this is not a fourth test double beside the three seams.
 */
const recording = (printed: Array<string>) => {
  const console_: Console.Console = Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
    error: () => {}
  })
  return Effect.provideService(Console.Console, console_)
}

const init = (...argv: ReadonlyArray<string>) => Command.runWith(dwMc, { version })(["init", ...argv])

describe("dw-mc init", () => {
  it.effect("sets the machine up, registers the repository and says what it did", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* init()

      assert.deepStrictEqual(printed, [
        "review      /code-review low",
        "config      /home/dw/.config/dw-mc/config.yaml",
        "state       /home/dw/.local/state/dw-mc",
        "repository  dominikwozniak/dw-mc (registered)"
      ])
      assert.deepStrictEqual(Option.getOrThrow(yield* read), {
        defaults: {
          base: null,
          review: {
            command: "/code-review",
            effort: "low",
            prompt: null,
            model: null,
            docs_only: ["**/*.md", "docs/**"]
          },
          ci: { ignore: [], flaky_patterns: [] },
          fix: { commits: false },
          rebase: { enabled: false },
          stamp: { blocks_on: "error" }
        },
        repos: { "dominikwozniak/dw-mc": {} }
      })
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }) })), recording(printed))
  })

  it.effect("writes the defaults out as YAML I can read and edit", () =>
    Effect.gen(function* () {
      yield* init()

      const config = yield* ConfigStore
      assert.strictEqual(
        yield* config.store.get("config.yaml"),
        "# dw-mc configuration. 'dw-mc init' rewrites this file and keeps no comments.\n" +
          "defaults:\n" +
          "  base: null\n" +
          "  review:\n" +
          `    command: "/code-review"\n` +
          "    effort: low\n" +
          "    prompt: null\n" +
          "    model: null\n" +
          "    docs_only:\n" +
          `      - "**/*.md"\n` +
          `      - "docs/**"\n` +
          "  ci:\n" +
          "    ignore: []\n" +
          "    flaky_patterns: []\n" +
          "  fix:\n" +
          "    commits: false\n" +
          "  rebase:\n" +
          "    enabled: false\n" +
          "  stamp:\n" +
          "    blocks_on: error\n" +
          "repos:\n" +
          "  dominikwozniak/dw-mc: {}\n"
      )
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }) })), recording([]))
  )

  it.effect("stops with somewhere to get gh when gh is not installed", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(init())

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "https://cli.github.com")
      assert.deepStrictEqual(yield* read, Option.none())
    }).pipe(Effect.provide(machine({ spawner: ghMissing })), recording([]))
  )

  it.effect("stops with what to run when gh is logged out", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(init())

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "gh auth login")
      assert.deepStrictEqual(yield* read, Option.none())
    }).pipe(Effect.provide(machine({ spawner: gh({ repo: said.repo }) })), recording([]))
  )

  it.effect("stops on a configuration file that is there and is wrong", () =>
    Effect.gen(function* () {
      const config = yield* ConfigStore
      yield* config.store.set("config.yaml", "defaults:\n  review:\n    commnad: /code-review\n")

      const error = yield* Effect.flip(init())

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "/home/dw/.config/dw-mc/config.yaml")
      assert.include(error.message, "commnad")
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }) })), recording([]))
  )

  it.effect("sets the machine up outside a repository and registers nothing", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* init()

      assert.strictEqual(printed[3], "repository  none here - run dw-mc init inside a repository to register it")
      assert.isUndefined(Option.getOrThrow(yield* read).repos)
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn }) })), recording(printed))
  })

  it.effect("leaves the state directory behind on the first run", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const xdg = yield* fs.makeTempDirectoryScoped()

      yield* init().pipe(
        Effect.provide(
          machine({
            spawner: gh({ auth: said.loggedIn, repo: said.repo }),
            env: { HOME: "/home/dw", XDG_STATE_HOME: xdg },
            fileSystem: NodeFileSystem.layer,
            state: Store.layer
          })
        ),
        recording(printed)
      )

      assert.isTrue(yield* fs.exists(path.join(xdg, "dw-mc")))
      assert.strictEqual(printed[2], `state       ${path.join(xdg, "dw-mc")}`)
    }).pipe(Effect.provide(Layer_.mergeAll(NodeFileSystem.layer, Path.layer)))
  })
})

describe("dw-mc init, run again", () => {
  const registered: ConfigFile = {
    defaults: { review: { effort: "medium", command: "/code-review" } },
    repos: {
      "dominikwozniak/dw-mc": {
        base: "develop",
        review: { effort: "low", docs_only: ["**/*.md"] },
        ci: { ignore: ["advisory"], flaky_patterns: [] }
      }
    }
  }

  it.effect("changes the settings it was given and keeps every other one", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* write(registered)

      yield* init("--effort", "high")

      const file = Option.getOrThrow(yield* read)
      const settings = settingsFor(file, "dominikwozniak/dw-mc")
      assert.strictEqual(settings.review.effort, "high")
      assert.deepStrictEqual(settings.review.docs_only, ["**/*.md"])
      assert.strictEqual(settings.base, "develop")
      assert.deepStrictEqual(settings.ci.ignore, ["advisory"])
      assert.deepStrictEqual(file.defaults, registered.defaults)
      assert.strictEqual(printed[3], "repository  dominikwozniak/dw-mc (already registered)")
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }) })), recording(printed))
  })

  it.effect("leaves the file alone when nothing was decided differently", () =>
    Effect.gen(function* () {
      yield* write(registered)
      const config = yield* ConfigStore
      const byHand = `# my own note\n${yield* config.store.get("config.yaml")}`
      yield* config.store.set("config.yaml", byHand)

      yield* init()

      assert.strictEqual(yield* config.store.get("config.yaml"), byHand)
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }) })), recording([]))
  )

  it.effect("rewrites the file when a flag decides something differently", () =>
    Effect.gen(function* () {
      yield* write(registered)
      const config = yield* ConfigStore
      yield* config.store.set("config.yaml", `# my own note\n${yield* config.store.get("config.yaml")}`)

      yield* init("--effort", "high")

      assert.notInclude(yield* config.store.get("config.yaml") ?? "", "my own note")
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }) })), recording([]))
  )

  it.effect("leaves a defaults block that only set some of them exactly as it is", () =>
    Effect.gen(function* () {
      yield* write({ defaults: { review: { effort: "high" }, rebase: { enabled: true } } })

      yield* init()

      const defaults = Option.getOrThrow(yield* read).defaults
      assert.deepStrictEqual(defaults, { review: { effort: "high" }, rebase: { enabled: true } })
      // What the file leaves out is inherited rather than reset, so a block I
      // wrote by hand is not filled in behind me.
      assert.strictEqual(settingsFor({ defaults }, "dominikwozniak/dw-mc").review.command, "/code-review")
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }) })), recording([]))
  )

  it.effect("sends the base branch to the repository it was run in", () =>
    Effect.gen(function* () {
      yield* write(registered)

      yield* init("--base", "main")

      const file = Option.getOrThrow(yield* read)
      assert.strictEqual(file.repos?.["dominikwozniak/dw-mc"]?.base, "main")
      assert.isUndefined(file.defaults?.base)
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }) })), recording([]))
  )

  it.effect("sends the base branch to the defaults when there is no repository here", () =>
    Effect.gen(function* () {
      yield* write(registered)

      yield* init("--base", "main")

      const file = Option.getOrThrow(yield* read)
      assert.strictEqual(file.defaults?.base, "main")
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn }) })), recording([]))
  )
})
