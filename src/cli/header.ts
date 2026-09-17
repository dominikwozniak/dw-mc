import type { Config, Stdio } from "effect"
import { Effect, Layer } from "effect"
import type { HelpDoc } from "effect/unstable/cli"
import { CliConfig, CliOutput, GlobalFlag } from "effect/unstable/cli"

import { paintFor, screened } from "#adapters/paint.ts"
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

/** The logo, with the tool's name and home set beside it. */
const header = (colors: boolean): string => {
  const width = Math.max(...logo.map((line) => line.length))
  const paint = paintFor(colors)
  return logo
    .map((line, index) => {
      const meta = beside[index] ?? ""
      // A row with nothing beside it keeps its own width, so no line of the
      // header ends in padding a terminal would still be colouring.
      return meta === "" ? paint.cyan(line) : `${paint.cyan(line.padEnd(width))}${gap}${paint.dim(meta)}`
    })
    .join("\n")
}

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
  Effect.map(screened, (colors) => {
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
