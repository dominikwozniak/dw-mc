import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"

import * as Store from "#adapters/store.ts"
import { acknowledge, acknowledgedAt } from "#domain/acknowledgement.ts"

const repo = "dominikwozniak/dw-mc"
const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso)

describe("acknowledgement", () => {
  it.effect("is null where I have acknowledged nothing", () =>
    Effect.gen(function* () {
      assert.isNull(yield* acknowledgedAt(repo, 28))
    }).pipe(Effect.provide(Store.layerTest))
  )

  it.effect("reads back the comment it covers, on that pull request only", () =>
    Effect.gen(function* () {
      yield* acknowledge(repo, 28, at("2026-09-17T15:04:00Z"))

      assert.deepStrictEqual(yield* acknowledgedAt(repo, 28), at("2026-09-17T15:04:00Z"))
      assert.isNull(yield* acknowledgedAt(repo, 29))
    }).pipe(Effect.provide(Store.layerTest))
  )

  it.effect("moves to the newer comment the next one covers", () =>
    Effect.gen(function* () {
      yield* acknowledge(repo, 28, at("2026-09-17T15:04:00Z"))
      yield* acknowledge(repo, 28, at("2026-09-18T09:00:00Z"))

      assert.deepStrictEqual(yield* acknowledgedAt(repo, 28), at("2026-09-18T09:00:00Z"))
    }).pipe(Effect.provide(Store.layerTest))
  )
})
