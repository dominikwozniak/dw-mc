import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import type { ConfigFile } from "#adapters/config.ts"
import { write } from "#adapters/config.ts"
import { prViewOf } from "#adapters/gh.ts"
import { recording } from "#adapters/picker.ts"
import { json, layerStubbed, vectorOf, wrote } from "#adapters/spawner.ts"
import { machineOf, run } from "#cli/cli.ts"
import { recordRerun, rerunFor } from "#domain/rerun.ts"

const repo = "dominikwozniak/dw-mc"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"
const runId = "35089608203"

/** One failing check of a workflow run, as `gh` answers with it in a rollup. */
const failed = (name: string, workflowName: string, id = runId) => ({
  name,
  workflowName,
  status: "COMPLETED",
  conclusion: "FAILURE",
  detailsUrl: `https://github.com/${repo}/actions/runs/${id}/job/104772538303`
})

const passed = (name: string) => ({ name, status: "COMPLETED", conclusion: "SUCCESS" })

/** Every program the command spawns, from fixtures, and a death for anything else. */
const machine = (options: {
  readonly spawned: Array<string>
  /** What CI says about the head. */
  readonly checks?: ReadonlyArray<Record<string, string>> | undefined
  /** What the failing jobs printed, which is the signal the classifier reads. */
  readonly log?: string | undefined
  /** Whether the same workflow is failing on the default branch too. */
  readonly redOnDefault?: boolean | undefined
  /** Who opened the pull request, where it was not me. */
  readonly author?: string | undefined
}) =>
  machineOf({
    spawner: layerStubbed({
      onSpawn: (command) => options.spawned.push(vectorOf(command)),
      stubs: [
        (_, argv) =>
          /^pr view 28 --repo \S+ --json \S+$/.test(argv)
            ? json(
                prViewOf(repo, {
                  number: 28,
                  title: "feat: re-run a flaky failure",
                  headRefOid: head,
                  headRefName: "feat/5-flaky-rerun",
                  author: options.author,
                  statusCheckRollup: options.checks ?? [failed("build", "Quality gate")]
                })
              )
            : undefined,
        (_, argv) => (argv === "api user" ? json({ login: "dominikwozniak" }) : undefined),
        (_, argv) => (argv.startsWith("repo view") ? json({ defaultBranchRef: { name: "main" } }) : undefined),
        (_, argv) =>
          argv.startsWith("run list")
            ? json(options.redOnDefault === true ? [{ conclusion: "failure" }] : [])
            : undefined,
        (_, argv) => (argv.startsWith("api repos") ? wrote(options.log ?? "") : undefined),
        (_, argv) => (argv.startsWith("run rerun") ? wrote("") : undefined)
      ]
    })
  })

const registered = write({ repos: { [repo]: {} } } satisfies ConfigFile)

const reruns = (spawned: ReadonlyArray<string>) => spawned.filter((vector) => vector.startsWith("gh run rerun"))

/** A log the built-in patterns call flaky. */
const flakyLog = "Error: connect ETIMEDOUT 140.82.121.5:443"

describe("dw-mc rerun", () => {
  it.effect("re-runs the failed jobs of a red CI the classifier excused", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered

      yield* run("rerun", "28")

      assert.deepStrictEqual(reruns(spawned), [`gh run rerun ${runId} --repo ${repo} --failed`])
      assert.include(printed.join("\n"), "ETIMEDOUT")
    }).pipe(Effect.provide(machine({ spawned, log: flakyLog })), recording(printed))
  })

  it.effect("writes down the head it re-ran at, and re-runs it no second time", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered

      yield* run("rerun", "28")
      assert.strictEqual(yield* rerunFor(repo, 28), head)

      const error = yield* Effect.flip(run("rerun", "28"))

      assert.include(String(error.cause), "already")
      assert.strictEqual(reruns(spawned).length, 1)
    }).pipe(Effect.provide(machine({ spawned, log: flakyLog })), recording(printed))
  })

  it.effect("re-runs a head nothing has re-run, whatever an older head earned", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* recordRerun(repo, 28, "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192")

      yield* run("rerun", "28")

      assert.strictEqual(reruns(spawned).length, 1)
    }).pipe(Effect.provide(machine({ spawned, log: flakyLog })), recording(printed))
  })

  it.effect("reports a legitimate failure and re-runs nothing", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered

      const error = yield* Effect.flip(run("rerun", "28"))

      assert.include(String(error.cause), "yours to fix")
      assert.deepStrictEqual(reruns(spawned), [])
      assert.strictEqual(yield* rerunFor(repo, 28), null)
    }).pipe(Effect.provide(machine({ spawned, log: "AssertionError: expected 1 to equal 2" })), recording(printed))
  })

  it.effect("has nothing to re-run where CI is green", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered

      const error = yield* Effect.flip(run("rerun", "28"))

      assert.include(String(error.cause), "not red")
      assert.deepStrictEqual(reruns(spawned), [])
    }).pipe(Effect.provide(machine({ spawned, checks: [passed("build")] })), recording(printed))
  })

  it.effect("re-runs each failing workflow run once, however many of its jobs failed", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []
    const checks = [failed("lint", "Quality gate"), failed("test", "Quality gate"), failed("build", "Release", "99")]

    return Effect.gen(function* () {
      yield* registered

      yield* run("rerun", "28")

      assert.deepStrictEqual(reruns(spawned), [
        `gh run rerun ${runId} --repo ${repo} --failed`,
        `gh run rerun 99 --repo ${repo} --failed`
      ])
    }).pipe(Effect.provide(machine({ spawned, checks, log: flakyLog })), recording(printed))
  })

  it.effect("leaves a check ci.ignore names out of what it re-runs", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []
    const checks = [failed("build", "Quality gate"), failed("codecov", "Coverage", "99")]

    return Effect.gen(function* () {
      yield* write({ repos: { [repo]: { ci: { ignore: ["codecov"] } } } } satisfies ConfigFile)

      yield* run("rerun", "28")

      assert.deepStrictEqual(reruns(spawned), [`gh run rerun ${runId} --repo ${repo} --failed`])
    }).pipe(Effect.provide(machine({ spawned, checks, log: flakyLog })), recording(printed))
  })

  it.effect("honours a flaky pattern I added myself", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []
    const log = "Error: the seeded fixture disagreed with the snapshot"

    return Effect.gen(function* () {
      yield* write({ repos: { [repo]: { ci: { flaky_patterns: ["seeded fixture disagreed"] } } } } satisfies ConfigFile)

      yield* run("rerun", "28")

      assert.deepStrictEqual(reruns(spawned), [`gh run rerun ${runId} --repo ${repo} --failed`])
      assert.include(printed.join("\n"), "seeded fixture disagreed")
    }).pipe(Effect.provide(machine({ spawned, log })), recording(printed))
  })

  it.effect("re-runs nothing on a pull request somebody else opened", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered

      const error = yield* Effect.flip(run("rerun", "28"))

      assert.include(String(error.cause), "not mine")
      assert.deepStrictEqual(reruns(spawned), [])
    }).pipe(Effect.provide(machine({ spawned, author: "someone-else", log: flakyLog })), recording(printed))
  })

  it.effect("says so where nothing red is a workflow run it can re-run, before asking the classifier", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []
    const checks = [{ context: "ci/circleci", state: "FAILURE", detailsUrl: "https://circleci.com/gh/dw/1" }]

    return Effect.gen(function* () {
      yield* registered

      const error = yield* Effect.flip(run("rerun", "28"))

      assert.include(String(error.cause), "workflow run")
      assert.deepStrictEqual(reruns(spawned), [])
      // The classifier costs reads of GitHub, and no verdict it could reach
      // would give this command a run id to hand `gh run rerun`.
      assert.deepStrictEqual(
        spawned.filter((vector) => vector.startsWith("gh api repos")),
        []
      )
    }).pipe(Effect.provide(machine({ spawned, checks })), recording(printed))
  })

  it.effect("refuses a head it has already re-run without paying for a second verdict", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* recordRerun(repo, 28, head)

      const error = yield* Effect.flip(run("rerun", "28"))

      assert.include(String(error.cause), "already")
      assert.deepStrictEqual(
        spawned.filter((vector) => vector.startsWith("gh api repos")),
        []
      )
    }).pipe(Effect.provide(machine({ spawned, log: flakyLog })), recording(printed))
  })
})
