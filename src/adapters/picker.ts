import type { Cause } from "effect"
import { Effect, Layer, Option, Queue, Terminal } from "effect"
import { Prompt } from "effect/unstable/cli"

/**
 * Turns quitting into an answer rather than a failure.
 *
 * Bailing out of a prompt gives `None`, so no caller has to catch an error to
 * learn that I walked away. The prompt itself decides what a `Some` carries.
 */
const orNone = <A, R>(
  prompt: Effect.Effect<Option.Option<A>, Terminal.QuitError, R>
): Effect.Effect<Option.Option<A>, never, R> => Effect.catchTag(prompt, "QuitError", () => Effect.succeedNone)

/** Asks which one of `choices` to act on. */
export const pick = <A>(
  message: string,
  choices: ReadonlyArray<Prompt.SelectChoice<A>>
): Effect.Effect<Option.Option<A>, never, Prompt.Environment> =>
  orNone(Effect.asSome(Prompt.Select({ message, choices })))

/**
 * Asks which of `choices` to act on, as many as I like.
 *
 * Nothing is selected to begin with, so what reaches the caller is what I
 * picked rather than what I failed to unpick. Quitting is not the same as
 * picking nothing: it gives `None`.
 */
export const choose = <A>(
  message: string,
  choices: ReadonlyArray<Prompt.SelectChoice<A>>
): Effect.Effect<Option.Option<ReadonlyArray<A>>, never, Prompt.Environment> =>
  orNone(Effect.asSome(Prompt.MultiSelect({ message, choices })))

/**
 * Asks for a line of prose, where having nothing to say is the ordinary answer.
 *
 * An empty line is no note, and that is not a failure: the prompt is optional
 * by design. Quitting is the one thing it does not swallow. Ctrl-C part way
 * through a list of notes means I want out of the whole command, and a prompt
 * that turned it into "no note" would walk me through the rest of the list and
 * then act on findings I was no longer sure about.
 */
export const note = (message: string): Effect.Effect<Option.Option<string>, Terminal.QuitError, Prompt.Environment> =>
  Effect.map(Prompt.String({ message }), (text) => (text.trim() === "" ? Option.none() : Option.some(text.trim())))

/**
 * How wide the screen is, or zero where there is no screen to measure.
 *
 * A prompt has to fit its row on one line: a row that wraps takes the list's
 * alignment with it. Nothing is piping into a prompt, so zero means the writing
 * is going somewhere that does not wrap either.
 */
export const width: Effect.Effect<number, never, Terminal.Terminal> = Effect.gen(function* () {
  const terminal = yield* Terminal.Terminal
  return yield* terminal.columns
})

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
  drawn?: Array<string>,
  columns: number = 80
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
        columns: Effect.succeed(columns),
        rows: Effect.succeed(24),
        readInput: Effect.succeed(queue),
        readLine: Effect.die("picker: a prompt never reads a line"),
        display: (text) => Effect.sync(() => drawn?.push(text))
      })
    })
  )
