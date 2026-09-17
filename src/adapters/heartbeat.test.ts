import { assert, describe, it } from "@effect/vitest"
import { Console, Duration, Effect } from "effect"
import { TestClock } from "effect/testing"

import type { Reads, Says } from "#adapters/heartbeat.ts"
import { beating } from "#adapters/heartbeat.ts"
import { layerScripted } from "#adapters/picker.ts"

/** What a run has reached for so far, as the command that counts would hold it. */
interface Doing {
  readonly tools: number
  readonly subagents: number
}

/** How the line reads, as the command that counts would word it. */
const reads =
  (doing: Doing): Reads =>
  (since) =>
    `reviewing · ${doing.tools} tools · ${doing.subagents} subagents · ${since}`

/** Collects what was printed a line at a time, beside what was drawn in place. */
const recording = (printed: Array<string>) => {
  const console_: Console.Console = Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
    error: () => {}
  })
  return Effect.provideService(Console.Console, console_)
}

/** A run that reaches for three tools, one of them a subagent, then finishes. */
const reaching = (says: Says) =>
  Effect.gen(function* () {
    let doing: Doing = { tools: 0, subagents: 0 }
    const onTool = (tool: string) => {
      doing = { tools: doing.tools + 1, subagents: doing.subagents + (tool === "Agent" ? 1 : 0) }
      return says(reads(doing), `  · ${tool}`)
    }
    yield* onTool("Bash")
    yield* onTool("Agent")
    yield* onTool("Bash")
    yield* TestClock.adjust(Duration.seconds(75))
    return "reviewed"
  })

/** Work that counts nothing at all, which is every command that reads two guards. */
const reading = () => Effect.as(TestClock.adjust(Duration.seconds(3)), "read")

const from = reads({ tools: 0, subagents: 0 })

describe("beating", () => {
  it.effect("keeps one line and says how far the work has got", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      assert.strictEqual(yield* beating(from, reaching), "reviewed")

      const screen = drawn.join("\n")
      assert.include(screen, "reviewing · 3 tools · 1 subagents · 1m15s")
      assert.deepStrictEqual(printed, [])
      // What the work leaves on the screen is the report, not its own heartbeat.
      assert.match(drawn.at(-1) ?? "", /^\r +\r$/)
    }).pipe(Effect.provide(layerScripted([], drawn)), recording(printed))
  })

  it.effect("beats for work that counts nothing, on the clock alone", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      assert.strictEqual(yield* beating(() => "reading GitHub", reading), "read")

      assert.include(drawn.join("\n"), "reading GitHub")
      assert.deepStrictEqual(printed, [])
      assert.match(drawn.at(-1) ?? "", /^\r +\r$/)
    }).pipe(Effect.provide(layerScripted([], drawn)), recording(printed))
  })

  it.effect("writes the asides out a line at a time where there is no screen to draw on", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      assert.strictEqual(yield* beating(from, reaching), "reviewed")

      assert.deepStrictEqual(printed, ["  · Bash", "  · Agent", "  · Bash"])
      assert.deepStrictEqual(drawn, [])
    }).pipe(Effect.provide(layerScripted([], drawn, 0)), recording(printed))
  })

  it.effect("says nothing at all where there is no screen and the work has no aside", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      // A sweep gives no aside, so a piped `dw-mc status` prints what it always did.
      const silent = (says: Says) =>
        Effect.as(
          says(() => "sweeping"),
          "swept"
        )
      assert.strictEqual(yield* beating(from, silent), "swept")

      assert.deepStrictEqual(printed, [])
      assert.deepStrictEqual(drawn, [])
    }).pipe(Effect.provide(layerScripted([], drawn, 0)), recording(printed))
  })

  it.effect("takes the heartbeat down when the work fails, and says nothing of its own", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(beating(from, () => Effect.fail("the run gave up" as const)))

      assert.strictEqual(error, "the run gave up")
      assert.match(drawn.at(-1) ?? "", /^\r +\r$/)
    }).pipe(Effect.provide(layerScripted([], drawn)), recording(printed))
  })
})
