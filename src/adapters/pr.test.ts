import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { comparedFiles, mergeabilityOf, reviewDecisionOf } from "#adapters/pr.ts"
import { fakeHandle, layerStubbed } from "#adapters/spawner.ts"

/** A spawner that answers every program the same way, and records the argv. */
const answering = (spawned: Array<ReadonlyArray<string>>, handle: Parameters<typeof fakeHandle>[0]) =>
  layerStubbed({
    onSpawn: (command) => spawned.push([command.command, ...command.args]),
    stubs: [() => Effect.succeed(fakeHandle(handle))]
  })

describe("gh's words in ours", () => {
  it("reads what gh says about merging", () => {
    assert.strictEqual(mergeabilityOf("MERGEABLE"), "mergeable")
    assert.strictEqual(mergeabilityOf("CONFLICTING"), "conflicting")
    assert.strictEqual(mergeabilityOf("UNKNOWN"), "unknown")
  })

  it("reads an empty review decision as nobody having been asked", () => {
    assert.strictEqual(reviewDecisionOf(""), "none")
    assert.strictEqual(reviewDecisionOf("APPROVED"), "approved")
    assert.strictEqual(reviewDecisionOf("CHANGES_REQUESTED"), "changes-requested")
    assert.strictEqual(reviewDecisionOf("REVIEW_REQUIRED"), "review-required")
  })
})

describe("comparedFiles", () => {
  const base = "284d599022a55d4dcae74b31b9a49a0f50061014"
  const head = "9c1f0b7a1d1e4a2c8b3f5d6e7a8b9c0d1e2f3a4b"

  it.effect("asks GitHub what changed between two commits", () => {
    const spawned: Array<ReadonlyArray<string>> = []
    const compared = answering(spawned, {
      stdout: JSON.stringify({ files: [{ filename: "README.md" }, { filename: "src/cli/review.ts" }] })
    })

    return Effect.gen(function* () {
      const files = yield* comparedFiles("dominikwozniak/dw-mc", base, head)

      assert.deepStrictEqual(files, ["README.md", "src/cli/review.ts"])
      assert.deepStrictEqual(spawned, [["gh", "api", `repos/dominikwozniak/dw-mc/compare/${base}...${head}`]])
    }).pipe(Effect.provide(compared))
  })

  it.effect("reads a comparison with nothing between its two commits", () => {
    const empty = answering([], { stdout: JSON.stringify({ status: "identical" }) })

    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* comparedFiles("dominikwozniak/dw-mc", base, base), [])
    }).pipe(Effect.provide(empty))
  })

  it.effect("says what it could not read rather than reporting no change", () => {
    const gone = answering([], { exitCode: 1, stderr: "gh: No commit found for SHA\n" })

    return Effect.gen(function* () {
      const error = yield* Effect.flip(comparedFiles("dominikwozniak/dw-mc", base, head))

      assert.strictEqual(error._tag, "GhReadFailed")
      assert.include(error.message, "No commit found")
    }).pipe(Effect.provide(gone))
  })
})
