import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option, Path, Schema } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { layerTest, stateDirectory, storeFor } from "./store.ts"

class ReviewRun extends Schema.Class<ReviewRun>("dw-mc/test/ReviewRun")({
  pr: Schema.Int,
  head: Schema.NonEmptyString,
  verdict: Schema.Literals(["clean", "findings"])
}) {}

describe("store", () => {
  it.effect("a schema store round-trips a value under its own namespace", () =>
    Effect.gen(function*() {
      const runs = yield* storeFor("review-run", ReviewRun)
      const run = new ReviewRun({ pr: 7, head: "cafe1234", verdict: "findings" })

      yield* runs.set("7", run)

      assert.deepStrictEqual(yield* runs.get("7"), Option.some(run))

      const raw = yield* KeyValueStore.KeyValueStore
      assert.strictEqual(
        yield* raw.get("review-run/7"),
        `{"pr":7,"head":"cafe1234","verdict":"findings"}`
      )
      assert.strictEqual(yield* raw.get("7"), undefined)
    }).pipe(Effect.provide(layerTest)))

  it.effect("a stored value that no longer matches the schema fails to decode", () =>
    Effect.gen(function*() {
      const raw = yield* KeyValueStore.KeyValueStore
      yield* raw.set("review-run/9", `{"pr":"seven","head":"cafe1234","verdict":"findings"}`)

      const runs = yield* storeFor("review-run", ReviewRun)
      const error = yield* Effect.flip(runs.get("9"))

      assert.strictEqual(error._tag, "SchemaError")
    }).pipe(Effect.provide(layerTest)))

  const env = (record: Record<string, string | undefined>) =>
    Effect.provide(
      Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnvRecord(record)), Path.layer)
    )

  it.effect("the state directory sits under XDG_STATE_HOME when it is set", () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* stateDirectory(), "/var/state/dw-mc")
    }).pipe(env({ XDG_STATE_HOME: "/var/state", HOME: "/home/dw" })))

  it.effect("the state directory falls back to the XDG default under HOME", () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* stateDirectory(), "/home/dw/.local/state/dw-mc")
    }).pipe(env({ HOME: "/home/dw" })))
})
