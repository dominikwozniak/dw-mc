import { Clock, Console, Duration, Effect, Fiber, Terminal } from "effect"

/** The frames of the spinner, in the order they turn. */
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** How long one frame is on the screen. */
const frameFor = Duration.millis(120)

/** What the run has reached for so far. */
interface Doing {
  tools: number
  subagents: number
}

/** A stretch of time as a terminal says it: `1m12s`, or `9s` under the minute. */
const elapsed = (millis: number): string => {
  const seconds = Math.floor(millis / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

/** `n` of something, pluralised the one way English usually is. */
const many = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`

/** The one line a run draws while it is going. */
const frame = (label: string, doing: Doing, since: number, turn: number): string => {
  const counts = [
    many(doing.tools, "tool"),
    doing.subagents === 0 ? null : many(doing.subagents, "subagent"),
    elapsed(since)
  ]
  return `${frames[turn % frames.length]} ${label} · ${counts.filter((part) => part !== null).join(" · ")}`
}

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
 * Where there is no screen to measure - a pipe, a CI log, a test - the counts
 * would be a mess of half-drawn lines, so the tools go out one to a line as
 * they did before. `columns` is zero exactly there.
 */
export const spinning = Effect.fnUntraced(function* <A, E, R>(
  label: string,
  use: (onTool: (tool: string) => Effect.Effect<void>) => Effect.Effect<A, E, R>
) {
  const terminal = yield* Terminal.Terminal
  const columns = yield* terminal.columns
  if (columns === 0) {
    return yield* use((tool) => Console.log(`  · ${tool}`))
  }

  const doing: Doing = { tools: 0, subagents: 0 }
  const onTool = (tool: string) =>
    Effect.sync(() => {
      doing.tools = doing.tools + 1
      if (tool === "Agent") {
        doing.subagents = doing.subagents + 1
      }
    })

  const started = yield* Clock.currentTimeMillis
  const draw = (text: string) => Effect.ignore(terminal.display(`\r${text.slice(0, columns - 1).padEnd(columns - 1)}`))

  // The first frame is drawn here rather than in the fiber, so the line is on
  // the screen the moment the run starts rather than one frame into it.
  yield* draw(frame(label, doing, 0, 0))
  const turning = yield* Effect.forkChild(
    Effect.gen(function* () {
      for (let turn = 1; ; turn = turn + 1) {
        yield* Effect.sleep(frameFor)
        yield* draw(frame(label, doing, (yield* Clock.currentTimeMillis) - started, turn))
      }
    })
  )

  return yield* Effect.onExit(use(onTool), () =>
    Effect.flatMap(Fiber.interrupt(turning), () => Effect.ignore(terminal.display(`\r${" ".repeat(columns - 1)}\r`)))
  )
})
