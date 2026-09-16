import { assert, describe, it } from "@effect/vitest"
import { Console, Duration, Effect } from "effect"
import { TestClock } from "effect/testing"

import { layerScripted } from "#adapters/picker.ts"
import { spinning } from "#adapters/progress.ts"

/** Collects what was printed a line at a time, beside what was drawn in place. */
const recording = (printed: Array<string>) => {
  const console_: Console.Console = Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
    error: () => {}
  })
  return Effect.provideService(Console.Console, console_)
}

/** A run that reaches for three tools, one of them a subagent, then finishes. */
const reaching = (onTool: (tool: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    yield* onTool("Bash")
    yield* onTool("Agent")
    yield* onTool("Bash")
    yield* TestClock.adjust(Duration.seconds(75))
    return "reviewed"
  })

describe("spinning", () => {
  it.effect("keeps one line and says how far the run has got", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      assert.strictEqual(yield* spinning("reviewing", reaching), "reviewed")

      const screen = drawn.join("\n")
      assert.include(screen, "reviewing · 3 tools · 1 subagent · 1m15s")
      assert.deepStrictEqual(printed, [])
      // What the run leaves on the screen is the report, not its own progress.
      assert.match(drawn.at(-1) ?? "", /^\r +\r$/)
    }).pipe(Effect.provide(layerScripted([], drawn)), recording(printed))
  })

  it.effect("writes the tools out a line at a time where there is no screen to draw on", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      assert.strictEqual(yield* spinning("reviewing", reaching), "reviewed")

      assert.deepStrictEqual(printed, ["  · Bash", "  · Agent", "  · Bash"])
      assert.deepStrictEqual(drawn, [])
    }).pipe(Effect.provide(layerScripted([], drawn, 0)), recording(printed))
  })

  it.effect("takes the spinner down when the run fails, and says nothing of its own", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(spinning("reviewing", () => Effect.fail("the runner gave up" as const)))

      assert.strictEqual(error, "the runner gave up")
      assert.match(drawn.at(-1) ?? "", /^\r +\r$/)
    }).pipe(Effect.provide(layerScripted([], drawn)), recording(printed))
  })
})
