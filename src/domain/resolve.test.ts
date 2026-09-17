import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import type { Situation } from "#domain/resolve.ts"
import { decide, promptFor } from "#domain/resolve.ts"

const repo = "dominikwozniak/dw-mc"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"
const moved = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"

/** The conflict JSON the prompt carries, as an object a test can read. */
const carried = (prompt: string): { readonly paths: ReadonlyArray<string> } =>
  JSON.parse(prompt.slice(prompt.indexOf("{")))

const situation = (over: Partial<Situation> = {}): Situation => ({
  repo,
  number: 28,
  mine: true,
  fromFork: false,
  listed: true,
  stack: null,
  head,
  conflictAt: head,
  ...over
})

describe("what a resolve session refuses", () => {
  it("opens on a pull request of mine whose current head has a conflict", () => {
    assert.isNull(decide(situation()))
  })

  it("says nothing about rebase.enabled, because it pushes nothing", () => {
    // The key exists so a force push is never a surprise, and the only push
    // here is my own from the worktree.
    assert.isNull(decide(situation()))
  })

  it("refuses a pull request somebody else opened", () => {
    assert.include(decide(situation({ mine: false })), "not mine")
  })

  it("refuses a pull request opened from a fork", () => {
    assert.include(decide(situation({ fromFork: true })), "fork")
  })

  it("refuses where the open pull requests it would read a stack from did not include it", () => {
    assert.include(decide(situation({ listed: false })), "stack")
  })

  it("refuses a stacked pull request and drives nothing", () => {
    const said = decide(situation({ stack: { position: 2, length: 3 } }))

    assert.include(said, "2 of 3")
    assert.include(said, "stack")
  })

  it("sends a pull request with no conflict at all to dw-mc rebase", () => {
    const said = decide(situation({ conflictAt: null }))

    assert.include(said, "dw-mc rebase 28")
    assert.include(said, "no conflict")
  })

  it("sends a pull request whose branch moved past its conflict to dw-mc rebase", () => {
    const said = decide(situation({ conflictAt: moved }))

    assert.include(said, "dw-mc rebase 28")
    assert.include(said, "9f2b0c1")
    assert.include(said, "284d599")
  })
})

describe("the prompt a resolve session opens on", () => {
  const conflicted = {
    repo,
    number: 28,
    head,
    base: "main",
    title: "feat: record what a rebase conflict hit",
    paths: ["src/cli/rebase.ts", "pnpm-lock.yaml"]
  }

  it.effect("carries what conflicted, what the pull request is for, and the base it stopped against", () =>
    Effect.gen(function* () {
      const prompt = yield* promptFor(conflicted)

      assert.include(prompt, `${repo}#28`)
      assert.include(prompt, "main")
      assert.include(prompt, "feat: record what a rebase conflict hit")
      assert.include(prompt, "src/cli/rebase.ts")
      assert.include(prompt, "pnpm-lock.yaml")
    })
  )

  it.effect("leaves the rebase, the commit and the push to me", () =>
    Effect.gen(function* () {
      const prompt = yield* promptFor(conflicted)

      assert.include(prompt, "git rebase --continue")
      assert.include(prompt, "Do not")
    })
  )

  it.effect("hands the files over as the JSON the schema defines, not as prose", () =>
    Effect.gen(function* () {
      const prompt = yield* promptFor(conflicted)

      assert.deepStrictEqual(carried(prompt).paths, ["src/cli/rebase.ts", "pnpm-lock.yaml"])
    })
  )
})
