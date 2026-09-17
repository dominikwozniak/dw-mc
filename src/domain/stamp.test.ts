import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"

import * as Store from "#adapters/store.ts"
import type { Facts } from "#domain/bucket.ts"
import { stampFor, stampOf, withdraw } from "#domain/stamp.ts"

const head = "31268022360852f71815404b6bbdd6bd797cfb4c"
const other = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"

/** A PR that has passed the whole bar: a clean run on its head, green, mergeable. */
const passing: Facts = {
  repo: "dominikwozniak/dw-mc",
  number: 24,
  title: "build: format with oxfmt",
  url: "https://github.com/dominikwozniak/dw-mc/pull/24",
  draft: false,
  head,
  mergeable: "mergeable",
  reviewDecision: "none",
  checks: "green",
  ciFlaky: null,
  rebaseConflictAt: null,
  newestHumanCommentAt: null,
  myLastCommentAt: null,
  myLastCommitAt: DateTime.makeUnsafe("2026-09-16T10:05:57Z"),
  reviewRunHead: head,
  blockingFindings: 0
}

const facts = (over: Partial<Facts>): Facts => ({ ...passing, ...over })

describe("stampFor", () => {
  it("stamps a PR with a clean review run on its head, green CI and a merge button", () => {
    assert.deepStrictEqual(stampFor(passing, null), {
      stamped: true,
      reason: "a clean review run on this head, green CI, mergeable"
    })
  })

  it("withholds the stamp from a head no review run has read", () => {
    assert.deepStrictEqual(stampFor(facts({ reviewRunHead: other }), null), {
      stamped: false,
      reason: "no review run on this head"
    })
    assert.strictEqual(stampFor(facts({ reviewRunHead: null }), null).stamped, false)
  })

  it("withholds the stamp where the run found something that blocks", () => {
    assert.deepStrictEqual(stampFor(facts({ blockingFindings: 1 }), null), {
      stamped: false,
      reason: "1 blocking finding"
    })
    assert.strictEqual(stampFor(facts({ blockingFindings: 3 }), null).reason, "3 blocking findings")
  })

  it("withholds the stamp from anything but green CI", () => {
    assert.deepStrictEqual(stampFor(facts({ checks: "red" }), null), { stamped: false, reason: "CI is red" })
    assert.strictEqual(stampFor(facts({ checks: "pending" }), null).reason, "CI is still running")
    assert.strictEqual(stampFor(facts({ checks: "none" }), null).reason, "no CI ran on this head")
  })

  it("withholds the stamp from a red CI the classifier excused, because the merge button is mine", () => {
    assert.strictEqual(
      stampFor(facts({ checks: "red", ciFlaky: "Quality gate is red on the default branch too" }), null).stamped,
      false
    )
  })

  it("withholds the stamp from a PR GitHub will not merge", () => {
    assert.deepStrictEqual(stampFor(facts({ mergeable: "conflicting" }), null), {
      stamped: false,
      reason: "merge conflict"
    })
    assert.strictEqual(stampFor(facts({ mergeable: "unknown" }), null).reason, "GitHub has not said whether it merges")
  })

  it("withholds the stamp I withdrew by hand, whatever the computation says", () => {
    assert.deepStrictEqual(stampFor(passing, head), { stamped: false, reason: "withdrawn by hand" })
  })

  it("computes the stamp again once the head has moved past the withdrawal", () => {
    assert.strictEqual(stampFor(passing, other).stamped, true)
  })
})

describe("a withdrawal on disk", () => {
  it.effect("withholds the stamp of the head it was made at", () =>
    Effect.gen(function* () {
      yield* withdraw(passing.repo, passing.number, head)

      assert.deepStrictEqual(yield* stampOf(passing), { stamped: false, reason: "withdrawn by hand" })
    }).pipe(Effect.provide(Store.layerTest))
  )

  it.effect("leaves the next head to the computation", () =>
    Effect.gen(function* () {
      yield* withdraw(passing.repo, passing.number, head)

      assert.strictEqual((yield* stampOf(facts({ head: other, reviewRunHead: other }))).stamped, true)
    }).pipe(Effect.provide(Store.layerTest))
  )

  it.effect("stamps a PR nothing has been withdrawn on", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* stampOf(passing)).stamped, true)
    }).pipe(Effect.provide(Store.layerTest))
  )
})
