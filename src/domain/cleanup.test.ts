import { assert, describe, it } from "@effect/vitest"
import { ByteSize } from "effect"

import type { Clone, Cut, Cutting, Inventory } from "#adapters/store.ts"
import { empty, everything, plan, standing, weight } from "#domain/cleanup.ts"

const clone = (repo: string, mb: number): Clone => ({
  repo,
  directory: `/state/repos/${repo}.git`,
  size: ByteSize.megabytes(mb)
})

const cutting = (cut: Cut, repo: string, number: number, mb: number): Cutting => ({
  cut,
  repo,
  number,
  directory: `/state/${cut}/${repo}/${number}`,
  size: ByteSize.megabytes(mb)
})

const inventory = (patch: Partial<Inventory>): Inventory => ({
  directory: "/state",
  clones: [],
  cuttings: [],
  records: { keys: 0, size: ByteSize.bytes(0) },
  ...patch
})

describe("cleanup", () => {
  it("takes back every clone and every review worktree", () => {
    const taken = plan(
      inventory({
        clones: [clone("dw/one", 100), clone("dw/two", 50)],
        cuttings: [cutting("worktrees", "dw/one", 28, 10)]
      })
    )

    assert.deepStrictEqual(
      taken.clones.map((found) => found.repo),
      ["dw/one", "dw/two"]
    )
    assert.deepStrictEqual(
      taken.worktrees.map((found) => found.number),
      [28]
    )
    assert.deepStrictEqual(taken.kept, [])
    assert.strictEqual(weight(taken.size), "160 MB")
  })

  it("leaves the clone a fix session stands on, and says which session", () => {
    const taken = plan(
      inventory({
        clones: [clone("dw/one", 100), clone("dw/two", 50)],
        cuttings: [cutting("fixes", "dw/one", 28, 10)]
      })
    )

    assert.deepStrictEqual(
      taken.clones.map((found) => found.repo),
      ["dw/two"]
    )
    assert.deepStrictEqual(
      taken.kept.map((found) => found.clone.repo),
      ["dw/one"]
    )
    assert.strictEqual(taken.kept[0]?.because, "a fix session stands on dw/one#28")
    assert.strictEqual(weight(taken.size), "50 MB")
  })

  it("names a resolve session by the word the glossary uses, not by its directory", () => {
    const taken = plan(inventory({ clones: [clone("dw/one", 1)], cuttings: [cutting("rebases", "dw/one", 7, 1)] }))

    assert.strictEqual(taken.kept[0]?.because, "a resolve session stands on dw/one#7")
  })

  it("takes the review worktree of a repository whose clone stays", () => {
    const taken = plan(
      inventory({
        clones: [clone("dw/one", 100)],
        cuttings: [cutting("fixes", "dw/one", 28, 10), cutting("worktrees", "dw/one", 31, 5)]
      })
    )

    assert.deepStrictEqual(taken.clones, [])
    assert.deepStrictEqual(
      taken.worktrees.map((found) => found.number),
      [31]
    )
    assert.strictEqual(weight(taken.size), "5 MB")
  })

  it("has nothing to do on a machine that has run nothing yet", () => {
    assert.isTrue(empty(plan(inventory({}))))
  })

  it("has something to do while a review worktree is left behind, with no clone at all", () => {
    assert.isFalse(empty(plan(inventory({ cuttings: [cutting("worktrees", "dw/one", 28, 1)] }))))
  })

  it("counts the standing sessions and not the review worktrees", () => {
    const found = standing(
      inventory({
        cuttings: [
          cutting("worktrees", "dw/one", 28, 1),
          cutting("fixes", "dw/one", 28, 1),
          cutting("rebases", "dw/two", 9, 1)
        ]
      })
    )

    assert.deepStrictEqual(
      found.map((one) => one.session),
      ["fix", "rebase"]
    )
  })

  it("weighs the whole state directory, records included", () => {
    const found = inventory({
      clones: [clone("dw/one", 100)],
      cuttings: [cutting("fixes", "dw/one", 28, 10)],
      records: { keys: 12, size: ByteSize.megabytes(2) }
    })

    assert.strictEqual(weight(everything(found)), "112 MB")
  })
})
