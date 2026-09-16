import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Path } from "effect"

import { choose, key, layerScripted, note, pick, typed } from "#adapters/picker.ts"

const buckets = [
  { title: "Needs me", value: "needs-me" },
  { title: "Needs review run", value: "needs-review-run" },
  { title: "Ready", value: "ready" }
]

describe("picker", () => {
  it.effect("pick returns the choice the scripted keys land on", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* pick("Which bucket?", buckets), Option.some("needs-review-run"))
    }).pipe(
      Effect.provide(Layer.mergeAll(layerScripted([key("down"), key("enter")]), FileSystem.layerNoop({}), Path.layer))
    )
  )

  it.effect("pick returns none when the user quits instead of choosing", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* pick("Which bucket?", buckets), Option.none())
    }).pipe(Effect.provide(Layer.mergeAll(layerScripted([]), FileSystem.layerNoop({}), Path.layer)))
  )

  it.effect("choose returns every choice the scripted keys toggled, and only those", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* choose("Which buckets?", buckets), Option.some(["needs-review-run", "ready"]))
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerScripted(
            [key("down"), key("down"), key("down"), key("space"), key("down"), key("space"), key("enter")],
            undefined
          ),
          FileSystem.layerNoop({}),
          Path.layer
        )
      )
    )
  )

  it.effect("choose returns nothing selected where nothing was toggled", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* choose("Which buckets?", buckets), Option.some([]))
    }).pipe(Effect.provide(Layer.mergeAll(layerScripted([key("enter")]), FileSystem.layerNoop({}), Path.layer)))
  )

  it.effect("choose returns none when the user quits instead of choosing", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* choose("Which buckets?", buckets), Option.none())
    }).pipe(Effect.provide(Layer.mergeAll(layerScripted([]), FileSystem.layerNoop({}), Path.layer)))
  )

  it.effect("note returns the line that was typed", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* note("Note?"), Option.some("rename it"))
    }).pipe(
      Effect.provide(
        Layer.mergeAll(layerScripted([...typed("rename it"), key("enter")]), FileSystem.layerNoop({}), Path.layer)
      )
    )
  )

  it.effect("note returns none for an empty line, because a note is optional", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* note("Note?"), Option.none())
    }).pipe(Effect.provide(Layer.mergeAll(layerScripted([key("enter")]), FileSystem.layerNoop({}), Path.layer)))
  )

  it.effect("note hands a quit on to its caller, so Ctrl-C can end the whole command", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(note("Note?"))

      assert.strictEqual(error._tag, "QuitError")
    }).pipe(Effect.provide(Layer.mergeAll(layerScripted([]), FileSystem.layerNoop({}), Path.layer)))
  )

  it.effect("a scripted terminal spends its keys once rather than replaying them", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* pick("Which bucket?", buckets), Option.some("needs-me"))
      assert.deepStrictEqual(yield* pick("Which bucket?", buckets), Option.none())
    }).pipe(Effect.provide(Layer.mergeAll(layerScripted([key("enter")]), FileSystem.layerNoop({}), Path.layer)))
  )
})
