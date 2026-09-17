import { Clock, Console, Duration, Effect, Fiber, Terminal } from "effect"

/** The frames of the spinner, in the order they turn. */
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** How long one frame is on the screen. */
const frameFor = Duration.millis(120)

/** A stretch of time as a terminal says it: `1m12s`, or `9s` under the minute. */
const elapsed = (millis: number): string => {
  const seconds = Math.floor(millis / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

/**
 * How the line reads, given how long the work has taken so far.
 *
 * The clock is the heartbeat's, because only the heartbeat knows when the work
 * started. Where in the line it goes is the command's, because only the command
 * knows what the rest of the line says.
 */
export type Reads = (since: string) => string

/**
 * How a command says the line reads from now on.
 *
 * `aside` is what goes out on its own line where there is no screen to rewrite.
 * A command with nothing worth a line there leaves it out, and that screen stays
 * as empty as it is today.
 */
export type Says = (reads: Reads, aside?: string) => Effect.Effect<void>

/**
 * Runs `use` while one line says the work is still going, and hands `use` the
 * way to say how that line reads.
 *
 * Work that takes seconds and prints nothing while it does is work I stop
 * trusting. What the screen showed instead was either silence or a line per
 * step, and a wall of `· Bash` says as little as silence did. This keeps one
 * line and rewrites it: the spinner says the work is alive, the words say how
 * far it has got, and the line is gone when the work is over, so what stays on
 * the screen is the report.
 *
 * What the line counts is the command's and not this module's business. A
 * review counts tools, a sweep counts pull requests, and a command reading two
 * guards counts nothing at all - and a screen that worded any of them here
 * would need the words a command already has.
 *
 * Where there is no screen to measure - a pipe, a CI log, a test - a rewritten
 * line would be a mess of half-drawn ones, so nothing is drawn. What goes out
 * instead is whatever `aside` the command gives, one to a line, and where it
 * gives none the output is what it was before there was a heartbeat at all.
 * `columns` is zero exactly there.
 */
export const beating = Effect.fnUntraced(function* <A, E, R>(from: Reads, use: (says: Says) => Effect.Effect<A, E, R>) {
  const terminal = yield* Terminal.Terminal
  const columns = yield* terminal.columns
  if (columns === 0) {
    return yield* use((_, aside) => (aside === undefined ? Effect.void : Console.log(aside)))
  }

  let reads = from
  const says: Says = (next) => Effect.sync(() => void (reads = next))

  const started = yield* Clock.currentTimeMillis
  const draw = (text: string) => Effect.ignore(terminal.display(`\r${text.slice(0, columns - 1).padEnd(columns - 1)}`))

  // The first frame is drawn here rather than in the fiber, so the line is on
  // the screen the moment the work starts rather than one frame into it.
  const frame = (since: number, at: number) => `${frames[at % frames.length]} ${reads(elapsed(since))}`

  yield* draw(frame(0, 0))
  const beat = yield* Effect.forkChild(
    Effect.gen(function* () {
      for (let at = 1; ; at = at + 1) {
        yield* Effect.sleep(frameFor)
        yield* draw(frame((yield* Clock.currentTimeMillis) - started, at))
      }
    })
  )

  return yield* Effect.onExit(use(says), () =>
    Effect.flatMap(Fiber.interrupt(beat), () => Effect.ignore(terminal.display(`\r${" ".repeat(columns - 1)}\r`)))
  )
})
