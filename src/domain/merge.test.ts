import { assert, describe, it } from "@effect/vitest"

import type { Situation } from "#domain/merge.ts"
import { decide } from "#domain/merge.ts"

const head = "31268022360852f71815404b6bbdd6bd797cfb4c"
const other = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"

/** A pull request over both bars: Ready as GitHub sees it, stamped as I do. */
const landable: Situation = {
  repo: "dominikwozniak/dw-mc",
  number: 57,
  head,
  mine: true,
  draft: false,
  reviewDecision: "approved",
  checks: "green",
  mergeable: "mergeable",
  reviewRunHead: head,
  blockingFindings: 0,
  withdrawnAt: null
}

const situation = (over: Partial<Situation>): Situation => ({ ...landable, ...over })

/** What the guards said about a pull request they refused, as something to read. */
const refusal = (over: Partial<Situation>): string => decide(situation(over)) ?? "merged"

describe("merge.decide", () => {
  it("merges a pull request that is Ready and carries my stamp", () => {
    assert.strictEqual(decide(landable), null)
  })

  it("merges one nobody was required to review, which produces no approval", () => {
    assert.strictEqual(decide(situation({ reviewDecision: "none" })), null)
  })

  it("refuses a pull request somebody else authored", () => {
    const why = refusal({ mine: false })

    assert.include(why, "not mine")
    assert.include(why, "I author")
  })

  it("refuses a draft, however green it is", () => {
    assert.include(refusal({ draft: true }), "draft")
  })

  it("refuses one GitHub does not call Ready", () => {
    assert.include(refusal({ reviewDecision: "changes-requested" }), "changes are requested")
    assert.include(refusal({ reviewDecision: "review-required" }), "someone else")
    assert.include(refusal({ checks: "red" }), "CI is red")
    assert.include(refusal({ checks: "pending" }), "CI is still running")
    assert.include(refusal({ checks: "none" }), "no CI ran")
    assert.include(refusal({ mergeable: "conflicting" }), "merge conflict")
    assert.include(refusal({ mergeable: "unknown" }), "GitHub has not said")
  })

  it("says a red CI is not Ready even where the whole of it is stamped otherwise", () => {
    // The flaky classifier excuses a red check from being mine to fix. It does
    // not excuse it from being red, and this is the write that cannot be undone.
    assert.include(refusal({ checks: "red" }), "not Ready")
  })

  it("refuses a Ready pull request no review run has read, and names what earns the stamp", () => {
    const why = refusal({ reviewRunHead: other })

    assert.include(why, "no review run on this head")
    assert.include(why, "dw-mc review 57")
  })

  it("refuses a Ready pull request a review run found something blocking on", () => {
    const why = refusal({ blockingFindings: 2 })

    assert.include(why, "2 blocking findings")
    assert.include(why, "dw-mc fix 57")
  })

  it("refuses one whose stamp I took off at this head, and offers no command for it", () => {
    const why = refusal({ withdrawnAt: head })

    assert.include(why, "withdrawn by hand")
    assert.notInclude(why, "dw-mc review")
  })

  it("ignores a withdrawal from a head that has gone", () => {
    assert.strictEqual(decide(situation({ withdrawnAt: other })), null)
  })

  it("puts the boundary before everything else it could say", () => {
    // Whose pull request it is is not one reason among several: a pull request
    // somebody else opened is none of this tool's business, whatever else is
    // true of it.
    const why = refusal({ mine: false, draft: true, checks: "red", reviewRunHead: other })

    assert.include(why, "not mine")
  })
})
