import type { Cause } from "effect"
import { Effect, Layer, Option, Queue, Terminal } from "effect"
import { Prompt } from "effect/unstable/cli"

/**
 * Asks which one of `choices` to act on.
 *
 * Quitting is an answer, not a failure: bailing out of the picker gives `None`
 * rather than an error the caller has to catch.
 */
export const pick = <A>(
  message: string,
  choices: ReadonlyArray<Prompt.SelectChoice<A>>
): Effect.Effect<Option.Option<A>, never, Prompt.Environment> =>
  Prompt.Select({ message, choices }).pipe(
    Effect.asSome,
    Effect.catchTag("QuitError", () => Effect.succeedNone)
  )

/** One keypress for a scripted terminal. */
export const key = (name: string): Terminal.UserInput => ({
  input: Option.none(),
  key: { name, ctrl: false, meta: false, shift: false }
})

/**
 * A terminal that answers with `keys` and records what was drawn, for tests.
 *
 * Effect ships no test terminal, so this builds one from `Terminal.make`. A
 * prompt only ever asks for `columns`, `display` and `readInput`; it never
 * calls `readLine`. Running out of keys ends the queue, which a prompt reads as
 * the user quitting.
 */
export const layerScripted = (
  keys: ReadonlyArray<Terminal.UserInput>,
  displayed?: Array<string>
): Layer.Layer<Terminal.Terminal> =>
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readInput: Effect.gen(function*() {
        const queue = yield* Queue.make<Terminal.UserInput, Cause.Done>()
        for (const stroke of keys) {
          Queue.offerUnsafe(queue, stroke)
        }
        Queue.endUnsafe(queue)
        return queue
      }),
      readLine: Effect.die("picker: a prompt never reads a line"),
      display: (text) =>
        Effect.sync(() => {
          displayed?.push(text)
        })
    })
  )
