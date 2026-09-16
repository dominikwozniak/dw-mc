import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Console, DateTime, Effect, FileSystem, Layer, Path, Stdio } from "effect"
import { Command } from "effect/unstable/cli"

import type { ConfigFile } from "#adapters/config.ts"
import { ConfigStore, write } from "#adapters/config.ts"
import { layerScripted } from "#adapters/picker.ts"
import { layerFake } from "#adapters/spawner.ts"
import * as Store from "#adapters/store.ts"
import { storeFor } from "#adapters/store.ts"
import { dwMc, version } from "#cli/cli.ts"
import type { Outcome } from "#domain/review.ts"
import { Latest, latestKey, ReviewRun, runKey } from "#domain/review.ts"

const repo = "dominikwozniak/dw-mc"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"
const session = "befb6186-5471-4b26-b680-e8ca49df25ac"

const found: Outcome = {
  _tag: "reported",
  verdict: "findings",
  findings: [
    { file: "src/cli/review.ts", line: 88, severity: "error", summary: "The run is never recorded." },
    { file: "docs/v1-design.md", line: 3, severity: "info", summary: "The build order is out of date." }
  ]
}

/**
 * Everything the command needs and nothing it spawns: reading findings is a
 * read of this machine, so a `gh` it reached for would be a bug and dies here.
 */
const machine = Layer.provideMerge(
  Layer.mergeAll(ConfigStore.layerTest, Store.layerTest),
  Layer.mergeAll(
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/home/dw" })),
    FileSystem.layerNoop({}),
    Path.layer,
    Stdio.layerTest({}),
    layerFake((command) => Effect.die(`findings.test: nothing is spawned, and ${command._tag} was`)),
    layerScripted([])
  )
)

const recording = (printed: Array<string>) => {
  const console_: Console.Console = Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
    error: () => {}
  })
  return Effect.provideService(Console.Console, console_)
}

const registered = (...repos: ReadonlyArray<string>) =>
  write({ repos: Object.fromEntries(repos.map((name) => [name, {}])) } satisfies ConfigFile)

const run = (...argv: ReadonlyArray<string>) => Command.runWith(dwMc, { version })(argv)

/** The review run `dw-mc review` would have left behind. */
const ran = (outcome: Outcome) =>
  Effect.gen(function* () {
    const runs = yield* storeFor("runs", ReviewRun)
    const latest = yield* storeFor("runs", Latest)
    yield* runs.set(runKey(repo, 28, head), {
      repo,
      number: 28,
      head,
      runner: "builtin",
      effort: "low",
      sessionId: session,
      ranAt: DateTime.makeUnsafe("2026-09-16T14:21:00Z"),
      outcome
    })
    yield* latest.set(latestKey(repo, 28), { head })
  })

describe("dw-mc findings", () => {
  it.effect("prints the findings as JSON and nothing else, so they pipe", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran(found)

      yield* run("findings", "28", "--json")

      assert.deepStrictEqual(printed, [
        `{"verdict":"findings","findings":[` +
          `{"file":"src/cli/review.ts","line":88,"summary":"The run is never recorded.","severity":"error"},` +
          `{"file":"docs/v1-design.md","line":3,"summary":"The build order is out of date.","severity":"info"}]}`
      ])
    }).pipe(Effect.provide(machine), recording(printed))
  })

  it.effect("reads them out as a table when nothing is piping them anywhere", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran(found)

      yield* run("findings", "28")

      assert.deepStrictEqual(printed, [
        `${repo}#28  284d599  2 findings, 1 blocking`,
        "  src/cli/review.ts:88  error  The run is never recorded.",
        "  docs/v1-design.md:3   info   The build order is out of date."
      ])
    }).pipe(Effect.provide(machine), recording(printed))
  })

  it.effect("says a clean run is clean", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran({ _tag: "reported", verdict: "clean", findings: [] })

      yield* run("findings", "28")

      assert.deepStrictEqual(printed, [`${repo}#28  284d599  clean, nothing to fix`])
    }).pipe(Effect.provide(machine), recording(printed))
  })

  it.effect("says what to run when the pull request has had no review run", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      const error = yield* Effect.flip(run("findings", "28"))

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "No review run")
      assert.include(error.message, "dw-mc review 28")
      assert.deepStrictEqual(printed, [])
    }).pipe(Effect.provide(machine), recording(printed))
  })

  it.effect("prints nothing for a run that could not report, rather than a clean verdict", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran({ _tag: "failed", detail: "the findings turn came back with no structured output" })

      const error = yield* Effect.flip(run("findings", "28", "--json"))

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "no structured output")
      assert.include(error.message, "--force")
      assert.deepStrictEqual(printed, [])
    }).pipe(Effect.provide(machine), recording(printed))
  })

  it.effect("asks which repository when a number alone cannot say", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo, "dominikwozniak/dotfiles")

      const error = yield* Effect.flip(run("findings", "28"))

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "2 repositories are registered")
    }).pipe(Effect.provide(machine), recording(printed))
  })
})
