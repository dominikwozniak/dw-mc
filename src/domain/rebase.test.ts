import { assert, describe, it } from "@effect/vitest"

import type { Branches } from "#domain/rebase.ts"
import { decide, stackOf } from "#domain/rebase.ts"

const repo = "dominikwozniak/dw-mc"

/** Three pull requests built on each other, and one standing on the base branch. */
const open: ReadonlyArray<Branches> = [
  { number: 28, head: "feat/28-the-bottom", base: "main" },
  { number: 29, head: "feat/29-the-middle", base: "feat/28-the-bottom" },
  { number: 30, head: "feat/30-the-top", base: "feat/29-the-middle" },
  { number: 31, head: "feat/31-on-its-own", base: "main" }
]

const situation = (over: Partial<Parameters<typeof decide>[0]> = {}) => ({
  repo,
  number: 28,
  base: "main",
  enabled: true,
  checks: "green" as const,
  stack: null,
  ...over
})

describe("stackOf", () => {
  it("has nothing to say about a branch nothing is built on", () => {
    assert.isNull(stackOf(31, open))
  })

  it("places the bottom of a stack at its bottom", () => {
    assert.deepStrictEqual(stackOf(28, open), { position: 1, length: 3 })
  })

  it("places the middle of a stack between the two it sits between", () => {
    assert.deepStrictEqual(stackOf(29, open), { position: 2, length: 3 })
  })

  it("places the top of a stack at its top", () => {
    assert.deepStrictEqual(stackOf(30, open), { position: 3, length: 3 })
  })

  it("counts the longest chain where one branch carries two", () => {
    const forked: ReadonlyArray<Branches> = [
      ...open,
      { number: 32, head: "feat/32-a-second-child", base: "feat/28-the-bottom" }
    ]

    assert.deepStrictEqual(stackOf(28, forked), { position: 1, length: 3 })
  })

  it("does not walk forever around branches that point at each other", () => {
    const circular: ReadonlyArray<Branches> = [
      { number: 40, head: "a", base: "b" },
      { number: 41, head: "b", base: "a" }
    ]

    assert.deepStrictEqual(stackOf(40, circular), { position: 2, length: 2 })
  })

  it("has nothing to say about a pull request that is not open", () => {
    assert.isNull(stackOf(99, open))
  })
})

describe("decide", () => {
  it("lets a branch with green CI through", () => {
    assert.isNull(decide(situation()))
  })

  it("lets a branch with no CI at all through", () => {
    assert.isNull(decide(situation({ checks: "none" })))
  })

  it("refuses where the repository has not turned rebase on", () => {
    const said = decide(situation({ enabled: false }))

    assert.include(said, "off")
    assert.include(said, repo)
    assert.include(said, "rebase.enabled")
  })

  it("reports a stacked pull request with its position and drives nothing", () => {
    const said = decide(situation({ stack: { position: 2, length: 3 } }))

    assert.include(said, "2 of 3")
    assert.include(said, "stack")
  })

  it("keeps its hands off a branch whose CI is still running", () => {
    const said = decide(situation({ checks: "pending" }))

    assert.include(said, "still running")
  })

  it("keeps its hands off a branch whose CI is red", () => {
    const said = decide(situation({ checks: "red" }))

    assert.include(said, "red")
  })

  it("says rebase is off before it says anything about the stack", () => {
    const said = decide(situation({ enabled: false, stack: { position: 1, length: 2 } }))

    assert.include(said, "off")
  })
})
