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
        "runner      builtin",
        "config      /home/dw/.config/dw-mc/config.yaml",
        "state       /home/dw/.local/state/dw-mc",
        "repository  dominikwozniak/dw-mc (registered)"
      ])
      assert.deepStrictEqual(Option.getOrThrow(yield* read), {
        defaults: {
          base: null,
          review: {
            runners: ["builtin"],
            effort: "low",
            model: null,
            skill: null,
            docs_only: ["**/*.md", "docs/**"],
            path_instructions: []
          },
          ci: { ignore: [], flaky_patterns: [] },
          rebase: { enabled: false },
          stamp: { blocks_on: "error" }
        },
        repos: { "dominikwozniak/dw-mc": {} }
      })
    }).pipe(
      Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }), keys: [key("enter")] })),
      recording(printed)
    )
  })

  it.effect("writes the defaults out as YAML I can read and edit", () =>
    Effect.gen(function* () {
      yield* init("--runner", "prompt")

      const config = yield* ConfigStore
      assert.strictEqual(
        yield* config.store.get("config.yaml"),
        "# dw-mc configuration. 'dw-mc init' rewrites this file and keeps no comments.\n" +
          "defaults:\n" +
          "  base: null\n" +
          "  review:\n" +
          "    runners:\n" +
          "      - prompt\n" +
          "    effort: low\n" +
          "    model: null\n" +
          "    skill: null\n" +
          "    docs_only:\n" +
          `      - "**/*.md"\n` +
          `      - "docs/**"\n` +
          "    path_instructions: []\n" +
          "  ci:\n" +
          "    ignore: []\n" +
          "    flaky_patterns: []\n" +
          "  rebase:\n" +
          "    enabled: false\n" +
          "  stamp:\n" +
          "    blocks_on: error\n" +
          "repos:\n" +
          "  dominikwozniak/dw-mc: {}\n"
      )
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }) })), recording([]))
  )

  it.effect("takes the runner from a flag rather than asking for it", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* init("--runner", "prompt")

      const file = Option.getOrThrow(yield* read)
      assert.deepStrictEqual(settingsFor(file, "dominikwozniak/dw-mc").review.runners, ["prompt"])
      assert.strictEqual(printed[0], "runner      prompt")
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }) })), recording(printed))
  })

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
      yield* config.store.set("config.yaml", "defaults:\n  review:\n    runner: builtin\n")

      const error = yield* Effect.flip(init())

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "/home/dw/.config/dw-mc/config.yaml")
      assert.include(error.message, "runner")
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }) })), recording([]))
  )

  it.effect("says what to pass when there is no terminal to answer the prompt", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(init())

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "--runner builtin")
      assert.deepStrictEqual(yield* read, Option.none())
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }) })), recording([]))
  )

  it.effect("sets the machine up outside a repository and registers nothing", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* init()

      assert.strictEqual(printed[3], "repository  none here - run dw-mc init inside a repository to register it")
      assert.isUndefined(Option.getOrThrow(yield* read).repos)
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn }), keys: [key("enter")] })), recording(printed))
  })

  it.effect("leaves the state directory behind on the first run", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const xdg = yield* fs.makeTempDirectoryScoped()

      yield* init("--runner", "builtin").pipe(
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
    defaults: { review: { effort: "medium", runners: ["builtin"] } },
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

  it.effect("spells the defaults out over a file that only set some of them", () =>
    Effect.gen(function* () {
      yield* write({ defaults: { review: { effort: "high" }, rebase: { enabled: true } } })

      yield* init("--runner", "prompt")

      const defaults = Option.getOrThrow(yield* read).defaults
      assert.strictEqual(defaults?.review?.effort, "high")
      assert.strictEqual(defaults?.rebase?.enabled, true)
      assert.deepStrictEqual(defaults?.review?.runners, ["prompt"])
      assert.deepStrictEqual(defaults?.stamp, { blocks_on: "error" })
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }) })), recording([]))
  )

  it.effect("does not ask for the runner a second time", () =>
    Effect.gen(function* () {
      yield* write(registered)

      yield* init()

      const file = Option.getOrThrow(yield* read)
      assert.deepStrictEqual(file.defaults?.review?.runners, ["builtin"])
    }).pipe(Effect.provide(machine({ spawner: gh({ auth: said.loggedIn, repo: said.repo }) })), recording([]))
  )

  it.effect("sends a new runner to the global defaults, not to the repository", () =>
    Effect.gen(function* () {
      yield* write(registered)

      yield* init("--runner", "prompt")

      const file = Option.getOrThrow(yield* read)
      assert.deepStrictEqual(file.defaults?.review?.runners, ["prompt"])
      assert.isUndefined(file.repos?.["dominikwozniak/dw-mc"]?.review?.runners)
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
