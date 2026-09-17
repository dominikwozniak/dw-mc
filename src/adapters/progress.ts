import { Clock, Console, Duration, Effect, Fiber, Terminal } from "effect"

/** The frames of the spinner, in the order they turn. */
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** How long one frame is on the screen. */
const frameFor = Duration.millis(120)

/** What the run has reached for so far. */
export interface Doing {
  readonly tools: number
  readonly subagents: number
}

/** A stretch of time as a terminal says it: `1m12s`, or `9s` under the minute. */
const elapsed = (millis: number): string => {
  const seconds = Math.floor(millis / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

/** How the line reads: the spinner, and whatever the caller makes of the counts. */
type Reads = (doing: Doing, since: string) => string

/**
 * Runs `use` while the screen says it is still going, and hands `use` the way
 * to report what the run reached for.
 *
 * A review takes minutes, and a terminal that prints nothing for minutes is one
 * I stop trusting. What it printed instead was a line per tool call, which is a
 * wall of `· Bash` that says as little as silence did. This keeps one line and
 * rewrites it: the spinner says the run is alive, the counts say how far it has
 * got, and the line is gone when the run is over, so what stays on the screen is
 * the report.
 *
 * How that line reads is `reads` and not this module's business. What a count
 * is worth saying belongs to the command that is counting, and a screen that
 * worded it here would need the words a command already has.
 *
 * Where there is no screen to measure - a pipe, a CI log, a test - the counts
 * would be a mess of half-drawn lines, so the tools go out one to a line as
 * they did before. `columns` is zero exactly there.
 */
export const spinning = Effect.fnUntraced(function* <A, E, R>(
  reads: Reads,
  use: (onTool: (tool: string) => Effect.Effect<void>) => Effect.Effect<A, E, R>
) {
  const terminal = yield* Terminal.Terminal
  const columns = yield* terminal.columns
  if (columns === 0) {
    return yield* use((tool) => Console.log(`  · ${tool}`))
  }

  let doing: Doing = { tools: 0, subagents: 0 }
  const onTool = (tool: string) =>
    Effect.sync(() => {
      doing = { tools: doing.tools + 1, subagents: doing.subagents + (tool === "Agent" ? 1 : 0) }
    })

  const started = yield* Clock.currentTimeMillis
  const draw = (text: string) => Effect.ignore(terminal.display(`\r${text.slice(0, columns - 1).padEnd(columns - 1)}`))

  // The first frame is drawn here rather than in the fiber, so the line is on
  // the screen the moment the run starts rather than one frame into it.
  const frame = (since: number, turn: number) => `${frames[turn % frames.length]} ${reads(doing, elapsed(since))}`

  yield* draw(frame(0, 0))
  const turning = yield* Effect.forkChild(
    Effect.gen(function* () {
      for (let turn = 1; ; turn = turn + 1) {
        yield* Effect.sleep(frameFor)
        yield* draw(frame((yield* Clock.currentTimeMillis) - started, turn))
      }
    })
  )

  return yield* Effect.onExit(use(onTool), () =>
    Effect.flatMap(Fiber.interrupt(turning), () => Effect.ignore(terminal.display(`\r${" ".repeat(columns - 1)}\r`)))
  )
})
