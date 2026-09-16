import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Path } from "effect"
import { key, layerScripted, pick } from "./picker.ts"

const buckets = [
  { title: "Needs me", value: "needs-me" },
  { title: "Needs review run", value: "needs-review-run" },
  { title: "Ready", value: "ready" }
]

describe("picker", () => {
  it.effect("pick returns the choice the scripted keys land on", () => {
    const displayed: Array<string> = []

    return Effect.gen(function*() {
      const chosen = yield* pick("Which bucket?", buckets)

      assert.deepStrictEqual(chosen, Option.some("needs-review-run"))
      assert.isTrue(displayed.some((frame) => frame.includes("Needs review run")))
    }).pipe(
      Effect.provide(Layer.mergeAll(
        layerScripted([key("down"), key("enter")], displayed),
        FileSystem.layerNoop({}),
        Path.layer
      ))
    )
  })

  it.effect("pick returns none when the user quits instead of choosing", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* pick("Which bucket?", buckets), Option.none())
    }).pipe(
      Effect.provide(Layer.mergeAll(layerScripted([]), FileSystem.layerNoop({}), Path.layer))
    ))
})
