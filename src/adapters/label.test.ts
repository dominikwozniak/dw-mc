import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { addLabel, labelDefined, removeLabel } from "#adapters/label.ts"
import { fakeHandle, json, layerStubbed, refused } from "#adapters/spawner.ts"

/** A spawner that answers every program the same way, and records the argv. */
const answering = (spawned: Array<ReadonlyArray<string>>, handle: Parameters<typeof fakeHandle>[0]) =>
  layerStubbed({
    onSpawn: (command) => spawned.push([command.command, ...command.args]),
    stubs: [() => Effect.succeed(fakeHandle(handle))]
  })

describe("labels", () => {
  const repo = "dominikwozniak/dw-mc"

  it.effect("finds a label the repository defines, escaped in the path", () => {
    const spawned: Array<ReadonlyArray<string>> = []
    return Effect.gen(function* () {
      assert.isTrue(yield* labelDefined(repo, "review: approved"))
      assert.deepStrictEqual(spawned, [["gh", "api", `repos/${repo}/labels/review%3A%20approved`]])
    }).pipe(
      Effect.provide(
        layerStubbed({
          onSpawn: (command) => spawned.push([command.command, ...command.args]),
          stubs: [() => json({ name: "review: approved" })]
        })
      )
    )
  })

  it.effect("reads a 404 as a label the repository does not define", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* labelDefined(repo, "review: approved"))
    }).pipe(Effect.provide(layerStubbed({ stubs: [() => refused("gh: Not Found (HTTP 404)")] })))
  )

  it.effect("fails on anything else gh refuses", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(labelDefined(repo, "review: approved"))
      assert.strictEqual(error._tag, "GhReadFailed")
    }).pipe(Effect.provide(layerStubbed({ stubs: [() => refused("gh: Bad credentials (HTTP 401)")] })))
  )

  it.effect("adds a label through REST, never through gh pr edit", () => {
    const spawned: Array<ReadonlyArray<string>> = []
    return Effect.gen(function* () {
      yield* addLabel(repo, 27, "review: approved")
      assert.deepStrictEqual(spawned, [
        ["gh", "api", "-X", "POST", `repos/${repo}/issues/27/labels`, "-f", "labels[]=review: approved"]
      ])
    }).pipe(Effect.provide(answering(spawned, { stdout: "[]" })))
  })

  it.effect("counts a label already gone as removed", () =>
    removeLabel(repo, 27, "review: changes").pipe(
      Effect.provide(layerStubbed({ stubs: [() => refused("gh: Label does not exist (HTTP 404)")] }))
    )
  )
})
