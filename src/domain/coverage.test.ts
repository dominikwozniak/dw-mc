import { assert, describe, it } from "@effect/vitest"

import { covered } from "#domain/coverage.ts"

const registered = ["byarcadia-app/grateful-me-app-v2", "dominikwozniak/dotfiles", "dominikwozniak/dw-mc"]

const nothingAsked = { repo: undefined, all: false }

describe("the repositories a sweep covers", () => {
  it("covers the repository I named, from anywhere", () => {
    assert.deepStrictEqual(
      covered({ repo: "dominikwozniak/dotfiles", all: false }, "dominikwozniak/dw-mc", registered),
      {
        _tag: "covers",
        repos: ["dominikwozniak/dotfiles"],
        leftOut: 2
      }
    )
  })

  it("refuses a repository I named that is not registered, and names the ones that are", () => {
    const coverage = covered({ repo: "someone/else", all: false }, undefined, registered)
    assert.strictEqual(coverage._tag, "refused")
    assert.include(coverage._tag === "refused" ? coverage.why : "", "someone/else is not registered")
    assert.include(coverage._tag === "refused" ? coverage.why : "", "dominikwozniak/dw-mc")
  })

  it("refuses a repository I named when none is registered, and says how to register it", () => {
    const coverage = covered({ repo: "someone/else", all: false }, undefined, [])
    assert.deepStrictEqual(coverage, {
      _tag: "refused",
      why: "someone/else is not registered. Run dw-mc init inside it to register it."
    })
  })

  it("refuses a repository and all of them at once", () => {
    assert.strictEqual(covered({ repo: "dominikwozniak/dw-mc", all: true }, undefined, registered)._tag, "refused")
  })

  it("covers every registered repository when I ask for all of them, wherever I stand", () => {
    assert.deepStrictEqual(covered({ repo: undefined, all: true }, "dominikwozniak/dw-mc", registered), {
      _tag: "covers",
      repos: registered,
      leftOut: 0
    })
  })

  it("covers the registered repository I stand in when I ask for nothing", () => {
    assert.deepStrictEqual(covered(nothingAsked, "dominikwozniak/dw-mc", registered), {
      _tag: "covers",
      repos: ["dominikwozniak/dw-mc"],
      leftOut: 2
    })
  })

  it("covers every registered repository when I stand in one nothing registered", () => {
    assert.deepStrictEqual(covered(nothingAsked, "someone/else", registered), {
      _tag: "covers",
      repos: registered,
      leftOut: 0
    })
  })

  it("covers every registered repository when I stand outside any repository", () => {
    assert.deepStrictEqual(covered(nothingAsked, undefined, registered), {
      _tag: "covers",
      repos: registered,
      leftOut: 0
    })
  })

  it("covers nothing when nothing is registered", () => {
    assert.deepStrictEqual(covered(nothingAsked, undefined, []), { _tag: "covers", repos: [], leftOut: 0 })
  })
})
