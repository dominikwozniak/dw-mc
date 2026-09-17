import { Config, Context, Effect, Layer, Option, Stdio } from "effect"

/**
 * The ink the screen is written in.
 *
 * Eight colours and two weights, which is what every terminal has had since
 * before any of them had a theme. Asking for one of the eight rather than for a
 * shade means the screen is drawn in my terminal's own palette, so it keeps its
 * contrast whatever I set that palette to.
 *
 * What each colour is worth is not decided here. This is the ink; which word
 * takes which colour belongs to whatever is doing the writing.
 */
export interface Paint {
  readonly red: (text: string) => string
  readonly yellow: (text: string) => string
  readonly green: (text: string) => string
  readonly cyan: (text: string) => string
  readonly bold: (text: string) => string
  readonly dim: (text: string) => string
}

const same = (text: string): string => text

/** The same screen, written where nothing is watching in colour. */
export const plain: Paint = { red: same, yellow: same, green: same, cyan: same, bold: same, dim: same }

const tint =
  (code: string) =>
  (text: string): string =>
    `[${code}m${text}[0m`

/** What a colour costs a line: the escape that opens it and the one that closes it. */
export const ink = 9

/** The screen written in colour. */
export const coloured: Paint = {
  red: tint("31"),
  yellow: tint("33"),
  green: tint("32"),
  cyan: tint("36"),
  bold: tint("1"),
  dim: tint("2")
}

/** The ink for a screen that may or may not be watched. */
export const paintFor = (colors: boolean): Paint => (colors ? coloured : plain)

/**
 * Whether the screen may be coloured: a terminal is watching and `NO_COLOR` is
 * unset.
 *
 * It is asked of the services rather than of `process`, so a test can put
 * either answer in, and an empty `NO_COLOR` reads as unset on both sides - the
 * configuration provider drops it, and `CliOutput.defaultFormatter` takes it
 * for the falsy value it is.
 */
export const screened: Effect.Effect<boolean, Config.ConfigError, Stdio.Stdio> = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const noColor = yield* Config.String("NO_COLOR").pipe(Config.option)
  return (yield* stdio.stdoutIsTerminal) && Option.isNone(noColor)
})

/**
 * The ink every command writes with.
 *
 * It defaults to no colour, so anything that provides nothing - a test, a
 * command reached some way I have not thought of - prints the text and only the
 * text. Colour arrives when the entry point builds the layer below, which is
 * the one place that knows what stdout is.
 */
export const Paint: Context.Reference<Paint> = Context.Reference("dw-mc/Paint", { defaultValue: (): Paint => plain })

/** The ink the machine deserves, as the layer the entry point provides. */
export const layer: Layer.Layer<never, Config.ConfigError, Stdio.Stdio> = Layer.effect(
  Paint,
  Effect.map(screened, paintFor)
)
