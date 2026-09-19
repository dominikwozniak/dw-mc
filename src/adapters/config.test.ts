import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option, Path, Predicate, SchemaAST } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"

import type { Settings, SettingsPatch } from "#adapters/config.ts"
import {
  builtIn,
  builtInLauncher,
  ConfigFile,
  configPath,
  ConfigStore,
  launcherOf,
  merge,
  read,
  settingsFor,
  write
} from "#adapters/config.ts"

const home = (record: Record<string, string | undefined> = { HOME: "/home/dw" }) =>
  Effect.provide(
    Layer.provideMerge(
      ConfigStore.layerTest,
      Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnvRecord(record)), Path.layer)
    )
  )

/**
 * Every key path a schema declares, `section.key` deep.
 *
 * A struct is the one shape the configuration nests, so a node that names its
 * properties is walked and every other node is a key. A record names none: it
 * is one key and not a shape, because what a repository holds is the same
 * `SettingsPatch` as `defaults`, and walking into it would name every key twice.
 */
const declaredBy = (ast: SchemaAST.AST, at: ReadonlyArray<string> = []): ReadonlyArray<string> =>
  SchemaAST.isObjects(ast) && ast.propertySignatures.length > 0
    ? ast.propertySignatures.flatMap((property) => declaredBy(property.type, [...at, String(property.name)]))
    : [at.join(".")]

/** What a value holds at one of those paths, or nothing where it holds nothing. */
const held = (value: unknown, path: ReadonlyArray<string>): unknown =>
  path.length === 0 ? value : Predicate.isReadonlyObject(value) ? held(value[path[0]], path.slice(1)) : undefined

const put = Effect.fnUntraced(function* (yaml: string) {
  const config = yield* ConfigStore
  yield* config.store.set("config.yaml", yaml)
})

describe("config file", () => {
  it.effect("sits under XDG_CONFIG_HOME when it is set", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* configPath, "/etc/xdg/dw-mc/config.yaml")
    }).pipe(home({ XDG_CONFIG_HOME: "/etc/xdg", HOME: "/home/dw" }))
  )

  it.effect("falls back to the XDG default under HOME", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* configPath, "/home/dw/.config/dw-mc/config.yaml")
    }).pipe(home())
  )

  it.effect("reads as missing until something is written", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* read, Option.none())
    }).pipe(home())
  )

  it.effect("round-trips what was written", () =>
    Effect.gen(function* () {
      const file: ConfigFile = {
        defaults: { review: { command: null, effort: "high" } },
        repos: { "dominikwozniak/dw-mc": { rebase: { enabled: true } } }
      }

      yield* write(file)

      assert.deepStrictEqual(yield* read, Option.some(file))
    }).pipe(home())
  )

  it.effect("keeps every key the schema has through a write and a read", () =>
    Effect.gen(function* () {
      const everything: SettingsPatch = {
        base: "develop",
        review: {
          command: "/code-review",
          effort: "medium",
          prompt: "Read the seams first",
          model: "claude-opus-5",
          docs_only: ["**/*.md"]
        },
        ci: { ignore: ["advisory"], flaky_patterns: ["ECONNRESET"] },
        fix: { commits: true },
        rebase: { enabled: true },
        stamp: { blocks_on: "warning" }
      }
      const file: ConfigFile = {
        launcher: { command: ["claude"], fix_args: ["--permission-mode", "acceptEdits"] },
        defaults: everything,
        repos: { "dominikwozniak/dw-mc": everything }
      }

      // The fixture is checked against the schema rather than trusted. Written
      // out by hand it had been missing `fix` since `fix` arrived, and a fixture
      // missing a key asserts nothing about that key: it would round-trip a file
      // the writer had quietly dropped it from.
      assert.deepStrictEqual(
        declaredBy(ConfigFile.ast).filter((key) => held(file, key.split(".")) === undefined),
        []
      )

      yield* write(file)

      assert.deepStrictEqual(yield* read, Option.some(file))
    }).pipe(home())
  )

  it.effect("is written in the order of the schema, so the file reads top down", () =>
    Effect.gen(function* () {
      yield* write({
        repos: { "dominikwozniak/dw-mc": {} },
        defaults: { stamp: { blocks_on: "warning" }, base: null }
      })

      const config = yield* ConfigStore
      assert.strictEqual(
        yield* config.store.get("config.yaml"),
        "# dw-mc configuration. 'dw-mc init' rewrites this file and keeps no comments.\n" +
          "defaults:\n" +
          "  base: null\n" +
          "  stamp:\n" +
          "    blocks_on: warning\n" +
          "repos:\n" +
          "  dominikwozniak/dw-mc: {}\n"
      )
    }).pipe(home())
  )

  it.effect("rejects a file that is not YAML, naming the file and the reason", () =>
    Effect.gen(function* () {
      yield* put("defaults:\n\tbase: main\n")

      const error = yield* Effect.flip(read)

      assert.strictEqual(error._tag, "ConfigMalformed")
      assert.include(error.message, "/home/dw/.config/dw-mc/config.yaml")
      assert.include(error.message, "Tabs cannot be used for YAML indentation")
      assert.include(error.message, "dw-mc init")
    }).pipe(home())
  )

  it.effect("rejects a value of the wrong type", () =>
    Effect.gen(function* () {
      yield* put("defaults:\n  rebase:\n    enabled: yesterday\n")

      const error = yield* Effect.flip(read)

      assert.strictEqual(error._tag, "ConfigMalformed")
      assert.include(error.message, "enabled")
    }).pipe(home())
  )

  it.effect("rejects an effort it does not have", () =>
    Effect.gen(function* () {
      yield* put("defaults:\n  review:\n    effort: exhaustive\n")

      const error = yield* Effect.flip(read)

      assert.strictEqual(error._tag, "ConfigMalformed")
    }).pipe(home())
  )

  it.effect("names the keys an earlier version had, and what replaced them", () =>
    Effect.gen(function* () {
      yield* put(
        "launcher:\n  codex:\n    - codex\n" +
          "defaults:\n  review:\n    runners:\n      - builtin\n    skill: my brief\n    path_instructions: []\n" +
          "  stamp:\n    supporting_blocks: true\n"
      )

      const error = yield* Effect.flip(read)

      assert.strictEqual(error._tag, "ConfigMalformed")
      assert.include(error.message, "review.runners is gone")
      assert.include(error.message, "review.skill is review.prompt now")
      assert.include(error.message, "review.path_instructions is gone")
      assert.include(error.message, "stamp.supporting_blocks is gone")
      assert.include(error.message, "launcher.codex is gone")
    }).pipe(home())
  )

  it.effect("rejects a repository key that is not owner/name", () =>
    Effect.gen(function* () {
      yield* put("repos:\n  dw-mc:\n    rebase:\n      enabled: true\n")

      const error = yield* Effect.flip(read)

      assert.strictEqual(error._tag, "ConfigMalformed")
      assert.include(error.message, `at ["repos"]["dw-mc"]`)
    }).pipe(home())
  )

  it.effect("rejects a misspelled key rather than ignoring it", () =>
    Effect.gen(function* () {
      yield* put("defaults:\n  review:\n    runner: builtin\n")

      const error = yield* Effect.flip(read)

      assert.strictEqual(error._tag, "ConfigMalformed")
      assert.include(error.message, "runner")
    }).pipe(home())
  )

  it.effect("reads an empty document as an empty configuration", () =>
    Effect.gen(function* () {
      yield* put("# nothing decided yet\n")

      assert.deepStrictEqual(yield* read, Option.some({}))
    }).pipe(home())
  )

  it.effect("carries a hand-written launcher through a rewrite, so init never drops it", () =>
    Effect.gen(function* () {
      const file: ConfigFile = {
        launcher: { command: ["cswap", "run", "--"], fix_args: ["--enable-auto-mode"] },
        repos: { "dominikwozniak/dw-mc": {} }
      }

      yield* write(file)

      assert.deepStrictEqual(yield* read, Option.some(file))
    }).pipe(home())
  )

  it.effect("rejects a launcher that names no program", () =>
    Effect.gen(function* () {
      yield* put("launcher:\n  command: []\n")

      const error = yield* Effect.flip(read)

      assert.strictEqual(error._tag, "ConfigMalformed")
      assert.include(error.message, "/home/dw/.config/dw-mc/config.yaml")
      assert.include(error.message, "command")
    }).pipe(home())
  )

  it.effect("keeps the store to itself, so state and configuration never collide", () =>
    Effect.gen(function* () {
      yield* write({})

      const state = yield* KeyValueStore.KeyValueStore
      assert.strictEqual(yield* state.get("config.yaml"), undefined)
    }).pipe(Effect.provide(KeyValueStore.layerMemory), home())
  )
})

describe("launcherOf", () => {
  it("starts claude itself when the file says nothing", () => {
    assert.deepStrictEqual(launcherOf({}), builtInLauncher)
  })

  it("starts what the file names, with the arguments it puts in front", () => {
    assert.deepStrictEqual(launcherOf({ launcher: { command: ["cswap", "run", "--"] } }), {
      command: ["cswap", "run", "--"],
      fix_args: []
    })
  })

  it("keeps the flags only a fix session gets", () => {
    assert.deepStrictEqual(launcherOf({ launcher: { fix_args: ["--enable-auto-mode"] } }), {
      command: ["claude"],
      fix_args: ["--enable-auto-mode"]
    })
  })
})

describe("settingsFor", () => {
  it("falls back to the built-in defaults when the file says nothing", () => {
    assert.deepStrictEqual(settingsFor({}, "dominikwozniak/dw-mc"), builtIn)
  })

  it("resolves the global defaults over the built-in ones", () => {
    const file: ConfigFile = { defaults: { review: { effort: "high" } } }

    const settings = settingsFor(file, "dominikwozniak/dw-mc")

    assert.strictEqual(settings.review.effort, "high")
    assert.strictEqual(settings.review.command, builtIn.review.command)
  })

  it("resolves a repository's settings over the global defaults", () => {
    const file: ConfigFile = {
      defaults: { review: { effort: "high", command: null }, rebase: { enabled: true } },
      repos: { "dominikwozniak/dw-mc": { review: { effort: "low" } } }
    }

    const settings = settingsFor(file, "dominikwozniak/dw-mc")

    assert.strictEqual(settings.review.effort, "low")
    assert.strictEqual(settings.review.command, null)
    assert.isTrue(settings.rebase.enabled)
  })

  it("leaves one repository's settings out of another's", () => {
    const file: ConfigFile = {
      defaults: { review: { effort: "medium" } },
      repos: { "dominikwozniak/other": { review: { effort: "high" } } }
    }

    assert.strictEqual(settingsFor(file, "dominikwozniak/dw-mc").review.effort, "medium")
  })

  it("lets a repository reset a global default back to null", () => {
    const file: ConfigFile = {
      defaults: { base: "develop" },
      repos: { "dominikwozniak/dw-mc": { base: null } }
    }

    assert.strictEqual(settingsFor(file, "dominikwozniak/dw-mc").base, null)
    assert.strictEqual(settingsFor(file, "dominikwozniak/other").base, "develop")
  })

  it("carries every key the file can set, so no setting is silently dropped", () => {
    const settings: Settings = {
      base: "develop",
      review: {
        command: "/review",
        effort: "high",
        prompt: "Read the seams first",
        model: "claude-opus-5",
        docs_only: ["**/*.mdx"]
      },
      ci: { ignore: ["advisory"], flaky_patterns: ["ECONNRESET"] },
      fix: { commits: true },
      rebase: { enabled: true },
      stamp: { blocks_on: "info" }
    }

    assert.deepStrictEqual(settingsFor({ defaults: settings }, "dominikwozniak/dw-mc"), settings)
    assert.deepStrictEqual(
      settingsFor({ repos: { "dominikwozniak/dw-mc": settings } }, "dominikwozniak/dw-mc"),
      settings
    )
  })
})

describe("merge", () => {
  it("takes every key the delta sets and keeps every key it does not", () => {
    const patch: SettingsPatch = {
      base: "develop",
      review: { effort: "low", docs_only: ["**/*.md"] },
      ci: { ignore: ["advisory"] },
      fix: { commits: false },
      rebase: { enabled: false },
      stamp: { blocks_on: "error" }
    }
    const delta: SettingsPatch = {
      review: { effort: "high" },
      ci: { flaky_patterns: ["ECONNRESET"] },
      fix: { commits: true },
      rebase: { enabled: true },
      stamp: { blocks_on: "warning" }
    }

    assert.deepStrictEqual(merge(patch, delta), {
      base: "develop",
      review: { effort: "high", docs_only: ["**/*.md"] },
      ci: { ignore: ["advisory"], flaky_patterns: ["ECONNRESET"] },
      fix: { commits: true },
      rebase: { enabled: true },
      stamp: { blocks_on: "warning" }
    })
  })

  it("leaves a patch alone where the delta decides nothing", () => {
    const patch: SettingsPatch = { review: { effort: "low" } }

    assert.deepStrictEqual(merge(patch, {}), patch)
  })
})
