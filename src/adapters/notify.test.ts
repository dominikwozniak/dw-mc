import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, PlatformError } from "effect"

import { announce } from "#adapters/notify.ts"
import { layerScripted } from "#adapters/picker.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"

const desktop = (spawned: Array<ReadonlyArray<string>>) =>
  layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("notify.test: the fake was handed a piped command")
    }
    spawned.push([command.command, ...command.args])
    return Effect.succeed(fakeHandle({}))
  })

const noDesktop = layerFake(() =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      description: "spawn osascript ENOENT"
    })
  )
)

describe("the end of a run", () => {
  it.effect("rings the terminal and puts the news on the desktop", () => {
    const spawned: Array<ReadonlyArray<string>> = []
    const drawn: Array<string> = []

    return Effect.gen(function* () {
      yield* announce("dw-mc review", "dominikwozniak/dw-mc#28: 3 findings")

      assert.deepStrictEqual(drawn, ["\u0007"])
      assert.deepStrictEqual(spawned, [
        ["osascript", "-e", `display notification "dominikwozniak/dw-mc#28: 3 findings" with title "dw-mc review"`]
      ])
    }).pipe(Effect.provide(Layer.mergeAll(layerScripted([], drawn), desktop(spawned))))
  })

  it.effect("says it in a quotation mark the notification cannot end early", () => {
    const spawned: Array<ReadonlyArray<string>> = []

    return Effect.gen(function* () {
      yield* announce("dw-mc review", `a "quoted" \\ backslash`)

      assert.strictEqual(
        spawned[0]?.[2],
        `display notification "a \\"quoted\\" \\\\ backslash" with title "dw-mc review"`
      )
    }).pipe(Effect.provide(Layer.mergeAll(layerScripted([]), desktop(spawned))))
  })

  it.effect("ends the run anyway on a machine that cannot show a notification", () => {
    const drawn: Array<string> = []

    return Effect.gen(function* () {
      yield* announce("dw-mc review", "dominikwozniak/dw-mc#28: 3 findings")

      assert.deepStrictEqual(drawn, ["\u0007"])
    }).pipe(Effect.provide(Layer.mergeAll(layerScripted([], drawn), noDesktop)))
  })
})
