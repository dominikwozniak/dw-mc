import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Stdio } from "effect"

import { coloured, ink, paintFor, plain, screened } from "#adapters/paint.ts"

/** The machine the screen is written on: a terminal or a pipe, with or without `NO_COLOR`. */
const machine = (terminal: boolean, env: Record<string, string> = {}) =>
  Layer.mergeAll(
    Stdio.layerTest({ stdoutIsTerminal: Effect.succeed(terminal) }),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))
  )

const asks = (terminal: boolean, env?: Record<string, string>) => Effect.provide(screened, machine(terminal, env))

describe("what the screen may be written in", () => {
  it.effect("colours it where a terminal is watching", () =>
    Effect.map(asks(true), (colours) => assert.isTrue(colours))
  )

  it.effect("leaves the colour out of a pipe", () => Effect.map(asks(false), (colours) => assert.isFalse(colours)))

  it.effect("obeys NO_COLOR on a terminal", () =>
    Effect.map(asks(true, { NO_COLOR: "1" }), (colours) => assert.isFalse(colours))
  )

  it.effect("reads an empty NO_COLOR as unset, the way the help screen does", () =>
    Effect.map(asks(true, { NO_COLOR: "" }), (colours) => assert.isTrue(colours))
  )
})

describe("the ink", () => {
  it("wraps a word in colour and closes it again", () => {
    assert.strictEqual(coloured.red("mine"), "[31mmine[0m")
    assert.strictEqual(coloured.dim("context"), "[2mcontext[0m")
  })

  it("writes the word and nothing else where there is no colour", () => {
    assert.strictEqual(plain.red("mine"), "mine")
    assert.strictEqual(paintFor(false), plain)
    assert.strictEqual(paintFor(true), coloured)
  })

  it("costs a line exactly what a prompt has to budget for", () => {
    // A prompt counts the rows it erases from the length of what it drew, so
    // `ink` is what one colour adds to a line that the screen never shows.
    assert.strictEqual(coloured.red("mine").length - "mine".length, ink)
  })
})
