import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option, Path } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"

import type { ConfigFile, Settings, SettingsPatch } from "#adapters/config.ts"
import { builtIn, configPath, ConfigStore, merge, read, settingsFor, write } from "#adapters/config.ts"

const home = (record: Record<string, string | undefined> = { HOME: "/home/dw" }) =>
  Effect.provide(
    Layer.provideMerge(
      ConfigStore.layerTest,
      Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnvRecord(record)), Path.layer)
    )
  )

const put = (yaml: string) =>
  Effect.gen(function* () {
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
        defaults: { review: { runners: ["prompt"], effort: "high" } },
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
          runners: ["builtin", "prompt"],
          effort: "medium",
          model: "claude-opus-5",
          skill: "code-review",
          docs_only: ["**/*.md"],
          path_instructions: [{ path: "src/**", instructions: "Read the seams first" }]
        },
        ci: { ignore: ["advisory"], flaky_patterns: ["ECONNRESET"] },
        rebase: { enabled: true },
        stamp: { blocks_on: "warning" }
      }
      const file: ConfigFile = { defaults: everything, repos: { "dominikwozniak/dw-mc": everything } }

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

  it.effect("rejects a runner it does not have", () =>
    Effect.gen(function* () {
      yield* put("defaults:\n  review:\n    runners:\n      - gemini\n")

      const error = yield* Effect.flip(read)

      assert.strictEqual(error._tag, "ConfigMalformed")
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

  it.effect("keeps the store to itself, so state and configuration never collide", () =>
    Effect.gen(function* () {
      yield* write({})

      const state = yield* KeyValueStore.KeyValueStore
      assert.strictEqual(yield* state.get("config.yaml"), undefined)
    }).pipe(Effect.provide(KeyValueStore.layerMemory), home())
  )
})

describe("settingsFor", () => {
  it("falls back to the built-in defaults when the file says nothing", () => {
    assert.deepStrictEqual(settingsFor({}, "dominikwozniak/dw-mc"), builtIn)
  })

  it("resolves the global defaults over the built-in ones", () => {
    const file: ConfigFile = { defaults: { review: { effort: "high" } } }

    const settings = settingsFor(file, "dominikwozniak/dw-mc")

    assert.strictEqual(settings.review.effort, "high")
    assert.deepStrictEqual(settings.review.runners, builtIn.review.runners)
  })

  it("resolves a repository's settings over the global defaults", () => {
    const file: ConfigFile = {
      defaults: { review: { effort: "high", runners: ["prompt"] }, rebase: { enabled: true } },
      repos: { "dominikwozniak/dw-mc": { review: { effort: "low" } } }
    }

    const settings = settingsFor(file, "dominikwozniak/dw-mc")

    assert.strictEqual(settings.review.effort, "low")
    assert.deepStrictEqual(settings.review.runners, ["prompt"])
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
        runners: ["prompt"],
        effort: "high",
        model: "claude-opus-5",
        skill: "code-review",
        docs_only: ["**/*.mdx"],
        path_instructions: [{ path: "src/**", instructions: "Read the seams first" }]
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
