import { Config, Context, Effect, Layer, Option, Stdio } from "effect"

/**
 * The ink the screen is written in.
 *
 * Eight colours and two weights, which is what every terminal has had since
 * before any of them had a theme. Asking for one of the eight rather than for a
 * shade means the screen is drawn in my terminal's own palette, so it keeps its
 * contrast whatever I set that palette to.
 *
 * A link is ink as well, and the one piece of it that is not a colour: it says
 * where a word leads rather than what it is worth, so it withholds nothing from
 * the marker and takes no colour of its own.
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
  /** `text`, carrying `url` for the terminal to open. */
  readonly link: (text: string, url: string) => string
}

const same = (text: string): string => text

/** The same screen, written where nothing is watching in colour. */
export const plain: Paint = { red: same, yellow: same, green: same, cyan: same, bold: same, dim: same, link: same }

const tint =
  (code: string) =>
  (text: string): string =>
    `[${code}m${text}[0m`

/** What a colour costs a line: the escape that opens it and the one that closes it. */
export const ink = 9

/**
 * A word a terminal opens: OSC 8, which wraps the text in the URL rather than
 * printing it.
 *
 * The text on the screen is unchanged, so a row reads the same where the
 * terminal knows the sequence and where it does not, and a pipe never sees it
 * at all - the ink below is chosen once, from whether a terminal is watching.
 */
const opens = (text: string, url: string): string => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`

/** The screen written in colour. */
export const coloured: Paint = {
  red: tint("31"),
  yellow: tint("33"),
  green: tint("32"),
  cyan: tint("36"),
  bold: tint("1"),
  dim: tint("2"),
  link: opens
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
export const Paint: Context.Reference<Paint> = Context.Reference("dw-mc/adapters/paint/Paint", {
  defaultValue: (): Paint => plain
})

/** The ink the machine deserves, as the layer the entry point provides. */
export const layer: Layer.Layer<never, Config.ConfigError, Stdio.Stdio> = Layer.effect(
  Paint,
  Effect.map(screened, paintFor)
)
