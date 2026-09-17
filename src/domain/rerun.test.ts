import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { layerTest } from "#adapters/store.ts"
import { decide, recordRerun, rerunFor } from "#domain/rerun.ts"

const head = "284d599022a55d4dcae74b31b9a49a0f50061014"

const situation = (over: Partial<Parameters<typeof decide>[0]> = {}) => ({
  repo: "dominikwozniak/dw-mc",
  number: 28,
  head,
  mine: true,
  checks: "red" as const,
  flaky: 'the log matches "timed out"',
  rerunAt: null,
  runs: ["11111"],
  ...over
})

describe("decide", () => {
  it("re-runs a red CI the classifier excused", () => {
    assert.strictEqual(decide(situation()), null)
  })

  it("leaves a legitimate failure alone, because it is mine to fix", () => {
    const refused = decide(situation({ flaky: null }))

    assert.include(refused, "dominikwozniak/dw-mc#28")
    assert.include(refused, "yours to fix")
  })

  it("re-runs a head once and refuses the second time", () => {
    const refused = decide(situation({ rerunAt: head }))

    assert.include(refused, "284d599")
    assert.include(refused, "already")
  })

  it("re-runs again once the branch has moved, because that is a different CI", () => {
    assert.strictEqual(decide(situation({ rerunAt: "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192" })), null)
  })

  it("refuses a pull request somebody else opened before it reads anything about its CI", () => {
    assert.include(decide(situation({ mine: false, flaky: null, checks: "green" })), "not mine")
  })

  it("has nothing to re-run where CI is not red", () => {
    for (const checks of ["green", "pending", "none"] as const) {
      assert.include(decide(situation({ checks })), "not red")
    }
  })

  it("says so where no failing check is a workflow run it can re-run", () => {
    assert.include(decide(situation({ runs: [] })), "workflow run")
  })
})

describe("the record a re-run leaves", () => {
  const repo = "dominikwozniak/dw-mc"

  it.effect("remembers the head it re-ran at", () =>
    Effect.gen(function* () {
      yield* recordRerun(repo, 28, head)

      assert.strictEqual(yield* rerunFor(repo, 28), head)
    }).pipe(Effect.provide(layerTest))
  )

  it.effect("has nothing to say about a pull request nothing has re-run", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* rerunFor(repo, 28), null)
    }).pipe(Effect.provide(layerTest))
  )

  it.effect("keeps one record per pull request, not one per repository", () =>
    Effect.gen(function* () {
      yield* recordRerun(repo, 28, head)

      assert.strictEqual(yield* rerunFor(repo, 29), null)
    }).pipe(Effect.provide(layerTest))
  )
})
