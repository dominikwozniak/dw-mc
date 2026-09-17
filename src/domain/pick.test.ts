import { assert, describe, it } from "@effect/vitest"

import type { Facts, Placed } from "#domain/bucket.ts"
import { place } from "#domain/bucket.ts"
import type { Standing } from "#domain/pick.ts"
import { actionsFor, argvFor } from "#domain/pick.ts"

const head = "284d599022a55d4dcae74b31b9a49a0f50061014"

const facts = (over: Partial<Facts> = {}): Facts => ({
  repo: "dominikwozniak/dw-mc",
  number: 28,
  title: "feat: a pull request",
  url: "https://github.com/dominikwozniak/dw-mc/pull/28",
  draft: false,
  head,
  mergeable: "mergeable",
  reviewDecision: "none",
  checks: "green",
  ciFlaky: null,
  rebaseConflictAt: null,
  newestHumanCommentAt: null,
  myLastCommentAt: null,
  myLastCommitAt: null,
  reviewRunHead: null,
  blockingFindings: 0,
  ...over
})

const placed = (over: Partial<Facts> = {}): Placed => {
  const mine = facts(over)
  return { facts: mine, placement: place(mine) }
}

const standing = (over: Partial<Standing> & { readonly placed: Placed }): Standing => ({
  stamped: false,
  rebasing: false,
  ...over
})

const offered = (of: Standing) => actionsFor(of).map((offer) => offer.action)

describe("the picker's actions", () => {
  it("offers a review on a pull request no run has covered", () => {
    assert.deepStrictEqual(offered(standing({ placed: placed() })), ["review"])
  })

  it("offers the report and a fix session once this head has been reviewed", () => {
    assert.deepStrictEqual(offered(standing({ placed: placed({ reviewRunHead: head }) })), [
      "review",
      "findings",
      "fix"
    ])
  })

  it("offers nothing to read where the run covered a head that has gone", () => {
    const moved = standing({ placed: placed({ reviewRunHead: "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192" }) })
    assert.deepStrictEqual(offered(moved), ["review"])
  })

  it("offers a rebase only where the repository turned rebase on", () => {
    assert.include(offered(standing({ placed: placed(), rebasing: true })), "rebase")
    assert.notInclude(offered(standing({ placed: placed() })), "rebase")
  })

  it("puts resolving a conflict first, because a conflict makes every other move stale", () => {
    const conflicted = standing({ placed: placed({ rebaseConflictAt: head }), rebasing: true })
    assert.strictEqual(offered(conflicted)[0], "resolve")
  })

  it("offers to resolve nothing where the conflict was at a head that has gone", () => {
    const moved = standing({ placed: placed({ rebaseConflictAt: "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192" }) })
    assert.notInclude(offered(moved), "resolve")
  })

  it("offers to withdraw the stamp only where there is a stamp to withdraw", () => {
    assert.include(offered(standing({ placed: placed(), stamped: true })), "withdraw")
    assert.notInclude(offered(standing({ placed: placed() })), "withdraw")
  })

  it("says what each action does in the words the picker shows", () => {
    const offers = actionsFor(standing({ placed: placed({ reviewRunHead: head }) }))
    assert.deepStrictEqual(
      offers.map((offer) => offer.title),
      ["Review this head again", "Show the review-run report", "Open a fix session on the findings"]
    )
    assert.strictEqual(actionsFor(standing({ placed: placed() }))[0]?.title, "Run a review")
  })

  it("names the pull request the way the commands take it", () => {
    assert.deepStrictEqual(argvFor("review", facts()), ["review", "dominikwozniak/dw-mc#28"])
    assert.deepStrictEqual(argvFor("fix", facts({ number: 3 })), ["fix", "dominikwozniak/dw-mc#3"])
  })

  it("withdraws the stamp through the stamp command's own flag", () => {
    assert.deepStrictEqual(argvFor("withdraw", facts()), ["stamp", "dominikwozniak/dw-mc#28", "--withdraw"])
  })
})
