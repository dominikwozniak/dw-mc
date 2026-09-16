import { assert, describe, it } from "@effect/vitest"

import { resolve } from "#domain/reference.ts"

const registered = ["dominikwozniak/dw-mc", "dominikwozniak/dotfiles"]

describe("a reference to a pull request", () => {
  it("takes the repository the reference spells out", () => {
    assert.deepStrictEqual(resolve("dominikwozniak/dw-mc#28", registered), {
      _tag: "resolved",
      repo: "dominikwozniak/dw-mc",
      number: 28
    })
  })

  it("reviews a pull request in a repository nothing registered", () => {
    assert.deepStrictEqual(resolve("someone/else#1", []), {
      _tag: "resolved",
      repo: "someone/else",
      number: 1
    })
  })

  it("takes the one registered repository when the reference is a number alone", () => {
    assert.deepStrictEqual(resolve("28", ["dominikwozniak/dw-mc"]), {
      _tag: "resolved",
      repo: "dominikwozniak/dw-mc",
      number: 28
    })
  })

  it("asks which repository when several are registered", () => {
    assert.deepStrictEqual(resolve("28", registered), { _tag: "ambiguous", repos: registered })
  })

  it("asks which repository when none is registered", () => {
    assert.deepStrictEqual(resolve("28", []), { _tag: "ambiguous", repos: [] })
  })

  it("refuses what is not a pull request at all", () => {
    for (const text of ["", "nonsense", "dominikwozniak/dw-mc", "#28", "28.5", "-28", "dw-mc#28", "a/b#c"]) {
      assert.deepStrictEqual(resolve(text, registered), { _tag: "unreadable", text }, text)
    }
  })

  it("refuses a repository that is a way out of the state directory", () => {
    for (const text of ["../..#28", "dominikwozniak/..#28", "../dw-mc#28", "./.#28"]) {
      assert.deepStrictEqual(resolve(text, registered), { _tag: "unreadable", text }, text)
    }
  })
})
