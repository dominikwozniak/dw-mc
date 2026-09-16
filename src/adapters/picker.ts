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

/**
 * Asks which of `choices` to act on, as many as I like.
 *
 * Nothing is selected to begin with, so what reaches the caller is what I
 * picked rather than what I failed to unpick. Quitting is an answer here too:
 * it gives `None`, which is not the same as picking nothing.
 */
export const choose = <A>(
  message: string,
  choices: ReadonlyArray<Prompt.SelectChoice<A>>
): Effect.Effect<Option.Option<ReadonlyArray<A>>, never, Prompt.Environment> =>
  Prompt.MultiSelect({ message, choices }).pipe(
    Effect.asSome,
    Effect.catchTag("QuitError", () => Effect.succeedNone)
  )

/**
 * Asks for a line of prose, where having nothing to say is the ordinary answer.
 *
 * An empty line and a quit are the same thing: no note. Neither is a failure,
 * because the prompt is optional by design.
 */
export const note = (message: string): Effect.Effect<Option.Option<string>, never, Prompt.Environment> =>
  Prompt.String({ message }).pipe(
    Effect.map((text) => (text.trim() === "" ? Option.none() : Option.some(text.trim()))),
    Effect.catchTag("QuitError", () => Effect.succeedNone)
  )

/** One keypress for a scripted terminal. */
export const key = (name: string): Terminal.UserInput => ({
  input: Option.none(),
  key: { name, ctrl: false, meta: false, shift: false }
})

/**
 * A line of typing for a scripted terminal, one keypress to the character.
 *
 * A keypress carries one code unit, which is what a terminal really delivers,
 * so the text is split the way a keyboard produces it rather than by grapheme.
 */
export const typed = (text: string): ReadonlyArray<Terminal.UserInput> =>
  text.split("").map((character) => ({
    input: Option.some(character),
    key: { name: character, ctrl: false, meta: false, shift: false }
  }))

/**
 * A terminal that answers with `keys` and draws into `drawn`, for tests.
 *
 * Effect ships no test terminal, so this builds one from `Terminal.make`. A
 * prompt only ever asks for `columns`, `display` and `readInput`; it never
 * calls `readLine`. The keys are queued once, so a second prompt over the same
 * terminal finds the script spent rather than replaying it. Running out of keys
 * ends the queue, which a prompt reads as the user quitting.
 *
 * What is drawn is kept only where a caller asks for it: a prompt redraws
 * itself on every keypress, and a test that is about the answer does not want
 * the frames.
 */
export const layerScripted = (
  keys: ReadonlyArray<Terminal.UserInput>,
  drawn?: Array<string>
): Layer.Layer<Terminal.Terminal> =>
  Layer.effect(
    Terminal.Terminal,
    Effect.gen(function* () {
      const queue = yield* Queue.make<Terminal.UserInput, Cause.Done>()
      for (const stroke of keys) {
        Queue.offerUnsafe(queue, stroke)
      }
      Queue.endUnsafe(queue)

      return Terminal.make({
        columns: Effect.succeed(80),
        rows: Effect.succeed(24),
        readInput: Effect.succeed(queue),
        readLine: Effect.die("picker: a prompt never reads a line"),
        display: (text) => Effect.sync(() => drawn?.push(text))
      })
    })
  )
