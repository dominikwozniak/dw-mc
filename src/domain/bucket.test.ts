import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"

import type { Facts } from "#domain/bucket.ts"
import { group, place } from "#domain/bucket.ts"

const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso)

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
  newestHumanCommentAt: null,
  myLastCommentAt: null,
  myLastCommitAt: at("2026-09-16T10:05:57Z"),
  reviewRunHead: "31268022360852f71815404b6bbdd6bd797cfb4c",
  blockingFindings: 0
}

const facts = (over: Partial<Facts>): Facts => ({ ...clean, ...over })

describe("place", () => {
  describe("needs me", () => {
    it("claims a PR that will not merge", () => {
      assert.deepStrictEqual(place(facts({ mergeable: "conflicting" })), {
        bucket: "needs-me",
        reason: "merge conflict"
      })
    })

    it("claims a PR whose CI is red", () => {
      assert.deepStrictEqual(place(facts({ checks: "red" })), { bucket: "needs-me", reason: "CI is red" })
    })

    it("leaves a red CI the classifier calls flaky alone", () => {
      assert.strictEqual(
        place(facts({ checks: "red", ciFlaky: "Quality gate is red on the default branch too" })).bucket,
        "ready"
      )
    })

    it("says so when the only thing between a PR and Ready is a red CI it excused", () => {
      assert.strictEqual(
        place(facts({ checks: "red", ciFlaky: 'the log matches "ETIMEDOUT"' })).reason,
        'mergeable (red CI called flaky: the log matches "ETIMEDOUT")'
      )
    })

    it("claims a PR a reviewer asked for changes on", () => {
      assert.deepStrictEqual(place(facts({ reviewDecision: "changes-requested" })), {
        bucket: "needs-me",
        reason: "changes requested"
      })
    })

    it("claims a PR with a blocking finding on its head", () => {
      assert.deepStrictEqual(place(facts({ blockingFindings: 2 })), {
        bucket: "needs-me",
        reason: "2 blocking findings"
      })
    })

    it("counts a single blocking finding in the singular", () => {
      assert.strictEqual(place(facts({ blockingFindings: 1 })).reason, "1 blocking finding")
    })

    it("claims a PR whose newest human comment is newer than my last commit", () => {
      assert.deepStrictEqual(
        place(facts({ myLastCommitAt: at("2026-09-15T08:00:00Z"), newestHumanCommentAt: at("2026-09-15T09:00:00Z") })),
        { bucket: "needs-me", reason: "a comment I have not answered" }
      )
    })

    it("leaves a human comment I have already replied to alone", () => {
      assert.strictEqual(
        place(
          facts({
            myLastCommitAt: at("2026-09-15T08:00:00Z"),
            newestHumanCommentAt: at("2026-09-15T09:00:00Z"),
            myLastCommentAt: at("2026-09-15T09:30:00Z")
          })
        ).bucket,
        "ready"
      )
    })

    it("counts a human comment as new when I have never touched the PR", () => {
      assert.strictEqual(
        place(
          facts({
            myLastCommitAt: null,
            myLastCommentAt: null,
            newestHumanCommentAt: at("2026-09-15T09:00:00Z")
          })
        ).bucket,
        "needs-me"
      )
    })

    it("takes the highest rule when two of them claim the same PR", () => {
      assert.strictEqual(
        place(facts({ mergeable: "conflicting", checks: "red", reviewDecision: "changes-requested" })).reason,
        "merge conflict"
      )
    })
  })

  it("puts a PR whose head has no review run in needs review run", () => {
    assert.deepStrictEqual(place(facts({ reviewRunHead: null })), {
      bucket: "needs-review-run",
      reason: "no review run on this head"
    })
  })

  it("puts a PR whose review run is a head behind in needs review run", () => {
    assert.strictEqual(
      place(facts({ reviewRunHead: "0000000000000000000000000000000000000000" })).bucket,
      "needs-review-run"
    )
  })

  it("prefers needs me over needs review run", () => {
    assert.strictEqual(place(facts({ reviewRunHead: null, reviewDecision: "changes-requested" })).bucket, "needs-me")
  })

  it("puts a PR waiting for someone else's review in waiting on others", () => {
    assert.deepStrictEqual(place(facts({ reviewDecision: "review-required" })), {
      bucket: "waiting-on-others",
      reason: "a review from someone else"
    })
  })

  it("puts a PR whose CI is still running in waiting on others", () => {
    assert.deepStrictEqual(place(facts({ checks: "pending" })), {
      bucket: "waiting-on-others",
      reason: "CI is still running"
    })
  })

  it("prefers needs review run over waiting on others", () => {
    assert.strictEqual(
      place(facts({ reviewRunHead: null, reviewDecision: "review-required" })).bucket,
      "needs-review-run"
    )
  })

  it("calls a reviewed, green and mergeable PR ready", () => {
    assert.deepStrictEqual(place(facts({ reviewDecision: "approved" })), {
      bucket: "ready",
      reason: "approved, green, mergeable"
    })
  })

  it("calls a PR in a repository that requires no reviewer ready too", () => {
    assert.deepStrictEqual(place(clean), { bucket: "ready", reason: "green, mergeable" })
  })

  it("claims for ready only what is actually true of the PR", () => {
    assert.strictEqual(place(facts({ checks: "none", mergeable: "unknown" })).reason, "nothing left to wait on")
    assert.strictEqual(place(facts({ checks: "none" })).reason, "mergeable")
  })

  it("does not hold a PR back for a mergeability GitHub has not computed yet", () => {
    assert.strictEqual(place(facts({ mergeable: "unknown" })).bucket, "ready")
  })

  it("buckets a draft by the same rules, because draft is a flag and not a bucket", () => {
    assert.deepStrictEqual(place(facts({ draft: true })), place(clean))
  })
})

describe("group", () => {
  it("orders the buckets by what I must act on first and drops the empty ones", () => {
    const grouped = group([
      facts({ number: 1, reviewDecision: "approved" }),
      facts({ number: 2, reviewRunHead: null }),
      facts({ number: 3, mergeable: "conflicting" })
    ])

    assert.deepStrictEqual(
      grouped.map((entry) => entry.bucket),
      ["needs-me", "needs-review-run", "ready"]
    )
    assert.deepStrictEqual(
      grouped.map((entry) => entry.placed.map((placed) => placed.facts.number)),
      [[3], [2], [1]]
    )
  })

  it("orders a bucket by repository and then by number", () => {
    const grouped = group([
      facts({ repo: "b/b", number: 2, reviewRunHead: null }),
      facts({ repo: "b/b", number: 1, reviewRunHead: null }),
      facts({ repo: "a/a", number: 9, reviewRunHead: null })
    ])

    assert.deepStrictEqual(
      grouped[0]?.placed.map((placed) => `${placed.facts.repo}#${placed.facts.number}`),
      ["a/a#9", "b/b#1", "b/b#2"]
    )
  })

  it("gives every tracked PR exactly one bucket", () => {
    const all = [
      clean,
      facts({ number: 2, mergeable: "conflicting" }),
      facts({ number: 3, checks: "red" }),
      facts({ number: 4, reviewDecision: "changes-requested" }),
      facts({ number: 5, blockingFindings: 1 }),
      facts({ number: 6, newestHumanCommentAt: at("2030-01-01T00:00:00Z") }),
      facts({ number: 7, reviewRunHead: null }),
      facts({ number: 8, reviewDecision: "review-required" }),
      facts({ number: 9, checks: "pending" }),
      facts({ number: 10, checks: "none", reviewDecision: "approved" })
    ]

    const placed = group(all).flatMap((entry) => entry.placed)
    assert.strictEqual(placed.length, all.length)
    assert.strictEqual(new Set(placed.map((entry) => entry.facts.number)).size, all.length)
  })

  it("has nothing to say about nothing", () => {
    assert.deepStrictEqual(group([]), [])
  })
})
