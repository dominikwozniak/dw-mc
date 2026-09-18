import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"

import * as Store from "#adapters/store.ts"
import { prKey } from "#adapters/store.ts"
import type { Facts, Placed } from "#domain/bucket.ts"
import { place } from "#domain/bucket.ts"
import { since, sighted, sinceAmong, watermark } from "#domain/watermark.ts"

const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso)
const shownAt = at("2026-09-18T09:00:00Z")

/** A PR with nothing wrong with it and a review run already on its head. */
const clean: Facts = {
  repo: "dominikwozniak/dw-mc",
  number: 24,
  title: "build: format with oxfmt",
  url: "https://github.com/dominikwozniak/dw-mc/pull/24",
  draft: false,
  head: "31268022360852f71815404b6bbdd6bd797cfb4c",
  mergeable: "mergeable",
  reviewDecision: "none",
  checks: "green",
  ciFlaky: null,
  rebaseConflictAt: null,
  newestHumanCommentAt: null,
  myLastCommentAt: null,
  myLastCommitAt: at("2026-09-16T10:05:57Z"),
  acknowledgedAt: null,
  reviewRunHead: "31268022360852f71815404b6bbdd6bd797cfb4c",
  blockingFindings: 0
}

const placed = (over: Partial<Facts> = {}): Placed => {
  const facts = { ...clean, ...over }
  return { facts, placement: place(facts) }
}

/** What `since` says of `now`, where the row was last shown as `then`. */
const between = (then: Partial<Facts>, now: Partial<Facts>) => since(sighted(placed(then), shownAt), placed(now))

describe("since", () => {
  it("calls a pull request never shown unseen, rather than moved", () => {
    assert.deepStrictEqual(since(undefined, placed()), { _tag: "unseen" })
  })

  it("marks nothing where nothing happened", () => {
    assert.deepStrictEqual(between({}, {}), { _tag: "still" })
  })

  it("marks nothing where only the head moved and the row says the same", () => {
    const head = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"
    assert.deepStrictEqual(between({}, { head, reviewRunHead: head }), { _tag: "still" })
  })

  it("names the bucket a pull request came from, with the facts that moved it", () => {
    assert.deepStrictEqual(between({}, { checks: "red" }), {
      _tag: "moved",
      from: "ready",
      what: ["CI green → red"]
    })
  })

  it("says what moved where the bucket stayed the same", () => {
    assert.deepStrictEqual(between({ checks: "red", blockingFindings: 1 }, { blockingFindings: 1 }), {
      _tag: "moved",
      from: undefined,
      what: ["CI red → green"]
    })
  })

  it("names the bucket alone where no fact it shows is what moved it", () => {
    const head = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"
    assert.deepStrictEqual(between({}, { head }), { _tag: "moved", from: "ready", what: [] })
  })

  it("counts a comment newer than the one last shown", () => {
    assert.deepStrictEqual(
      between(
        { newestHumanCommentAt: at("2026-09-17T09:00:00Z"), acknowledgedAt: at("2026-09-17T09:00:00Z") },
        { newestHumanCommentAt: at("2026-09-18T10:00:00Z"), acknowledgedAt: at("2026-09-17T09:00:00Z") }
      ),
      { _tag: "moved", from: "ready", what: ["a new comment"] }
    )
  })

  it("says every fact that moved, in the order the bucket rules read them", () => {
    assert.deepStrictEqual(
      between(
        { reviewDecision: "review-required", checks: "pending", draft: true },
        { reviewDecision: "approved", checks: "green", mergeable: "conflicting", blockingFindings: 2 }
      ),
      {
        _tag: "moved",
        from: "waiting-on-others",
        what: [
          "mergeable → conflicting",
          "CI pending → green",
          "review required → approved",
          "0 → 2 blocking findings",
          "out of draft"
        ]
      }
    )
  })

  it("tells a red CI it excused from one it did not", () => {
    assert.deepStrictEqual(between({ checks: "red" }, { checks: "red", ciFlaky: "Quality gate is red on main too" }), {
      _tag: "moved",
      from: "needs-me",
      what: ["CI red → red, called flaky"]
    })
  })

  it("passes over a mergeability GitHub has not worked out yet", () => {
    assert.deepStrictEqual(between({}, { mergeable: "unknown" }), { _tag: "still" })
    assert.deepStrictEqual(between({ mergeable: "unknown" }, {}), { _tag: "still" })
  })
})

describe("watermark", () => {
  it.effect("reads back what was shown, for the pull requests that were", () =>
    Effect.gen(function* () {
      const shown = placed()
      const other = placed({ number: 25 })
      yield* watermark([shown])

      const found = yield* sinceAmong([shown, other])
      assert.deepStrictEqual(found.get(prKey(clean.repo, 24)), { _tag: "still" })
      assert.deepStrictEqual(found.get(prKey(clean.repo, 25)), { _tag: "unseen" })
    }).pipe(Effect.provide(Store.layerTest))
  )

  it.effect("moves to what was shown the next time", () =>
    Effect.gen(function* () {
      yield* watermark([placed()])
      yield* watermark([placed({ checks: "red" })])

      const found = yield* sinceAmong([placed({ checks: "red" })])
      assert.deepStrictEqual(found.get(prKey(clean.repo, 24)), { _tag: "still" })
    }).pipe(Effect.provide(Store.layerTest))
  )
})
