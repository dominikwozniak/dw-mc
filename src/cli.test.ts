import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { dwMc, version } from "./cli.ts"

describe("dw-mc cli", () => {
  it.effect("exposes the root command under the binary name", () =>
    Effect.gen(function*() {
      assert.strictEqual(dwMc.name, "dw-mc")
      assert.strictEqual(version, "0.0.0")
    }))
})
