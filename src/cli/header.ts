import { Config, Effect, Layer, Option, Stdio } from "effect"
import type { HelpDoc } from "effect/unstable/cli"
import { CliConfig, CliOutput, GlobalFlag } from "effect/unstable/cli"

import { projectUrl, version } from "#cli/cli.ts"

/** The tool's name, drawn. Plain ASCII, so a pipe and a paste show one picture. */
const logo = [
  "     _",
  "  __| |__      __       _ __ ___    ___",
  " / _` |\\ \\ /\\ / / ___  | '_ ` _ \\  / __|",
  "| (_| | \\ V  V / |___| | | | | | || (__",
  " \\__,_|  \\_/\\_/        |_| |_| |_| \\___|"
]

/** What stands beside the logo, row by row: what this is, and where it lives. */
const beside = ["", `mission control ${version}`, projectUrl, ""]

const gap = "    "
const cyan = "36"
const dim = "2"

/** The logo, with the tool's name and home set beside it. */
const header = (colors: boolean): string => {
  const width = Math.max(...logo.map((line) => line.length))
  const tint = (text: string, code: string) => (colors ? `\u001b[${code}m${text}\u001b[0m` : text)
  return logo
    .map((line, index) => {
      const meta = beside[index] ?? ""
      // A row with nothing beside it keeps its own width, so no line of the
      // header ends in padding a terminal would still be colouring.
      return meta === "" ? tint(line, cyan) : `${tint(line.padEnd(width), cyan)}${gap}${tint(meta, dim)}`
    })
    .join("\n")
}

/**
 * Whether the header may use colour, by the rule the rest of the screen
 * follows: a terminal is watching and `NO_COLOR` is set to something. It is
 * asked of the services rather than of `process`, so a test can put either
 * answer in, and an empty `NO_COLOR` reads as unset on both sides - the
 * configuration provider drops it, and `CliOutput.defaultFormatter` takes it
 * for the falsy value it is.
 */
const coloured = Effect.fnUntraced(function* () {
  const stdio = yield* Stdio.Stdio
  const noColor = yield* Config.String("NO_COLOR").pipe(Config.option)
  return (yield* stdio.stdoutIsTerminal) && Option.isNone(noColor)
})

/**
 * The formatter for the two screens the tool introduces itself on, with the
 * header above what the default formatter draws.
 *
 * The root command is the one whose help document lists subcommands, which is
 * what keeps the header off `dw-mc status --help`.
 */
const formatter = (colors: boolean): CliOutput.Formatter => {
  const inner = CliOutput.defaultFormatter({ colors })
  const drawn = header(colors)
  return {
    formatHelpDoc: (doc: HelpDoc.HelpDoc) =>
      doc.subcommands === undefined ? inner.formatHelpDoc(doc) : `${drawn}\n\n${inner.formatHelpDoc(doc)}`,
    formatVersion: (name: string, printed: string) => `${drawn}\n\n${inner.formatVersion(name, printed)}`,
    formatCliError: inner.formatCliError,
    formatError: inner.formatError,
    formatErrors: inner.formatErrors
  }
}

/**
 * The header, as the layer the entry point provides for the whole CLI.
 *
 * It replaces the formatter under `--help` and `--version` rather than for the
 * run, because a failed parse prints the help screen through the same
 * formatter: decorating that one would bury the error under a logo.
 */
export const layer: Layer.Layer<never, Config.ConfigError, Stdio.Stdio> = Layer.unwrap(
  Effect.map(coloured(), (colors) => {
    const introducing = Effect.provideService(CliOutput.Formatter, formatter(colors))
    return CliConfig.layer({
      builtIns: CliConfig.defaults.builtIns.map((builtIn) =>
        builtIn === GlobalFlag.Help || builtIn === GlobalFlag.Version
          ? GlobalFlag.Action({ flag: builtIn.flag, run: (value, context) => introducing(builtIn.run(value, context)) })
          : builtIn
      )
    })
  })
)
