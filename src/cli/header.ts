import type { Path, Stdio } from "effect"
import { Config, Effect, Layer, Option } from "effect"
import type { HelpDoc } from "effect/unstable/cli"
import { CliConfig, CliOutput, GlobalFlag } from "effect/unstable/cli"

import { ConfigStore, read } from "#adapters/config.ts"
import type { Paint } from "#adapters/paint.ts"
import { paintFor, screened } from "#adapters/paint.ts"
import { stateDirectory } from "#adapters/store.ts"
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

/** Where this machine keeps its setup, worked out from the environment alone. */
interface Setup {
  readonly config: string
  readonly state: string
}

/** A path under my home, the way I would type it. */
const tilde = (path: string, home: string | undefined): string =>
  home !== undefined && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path

/**
 * What the configuration file says of this machine, in the few words a help
 * screen has room for.
 *
 * A file that cannot be read keeps the help screen standing and says only that
 * it cannot: the reason is ADR 0010's, and every other command prints it.
 */
const registration = read.pipe(
  Effect.map(
    Option.match({
      onNone: () => "not set up - run dw-mc init",
      onSome: (file) => {
        const n = Object.keys(file.repos ?? {}).length
        return n === 1 ? "1 repository registered" : `${n} repositories registered`
      }
    })
  ),
  Effect.catchTag("ConfigMalformed", () => Effect.succeed("cannot be read - any other command says why"))
)

/**
 * The two lines naming this machine's setup, with the labels `dw-mc init`
 * prints. The paths are dimmed as context, and nothing is coloured by state.
 */
const described = (setup: Setup, registered: string, paint: Paint): ReadonlyArray<string> => [
  `config  ${paint.dim(setup.config)}   ${registered}`,
  `state   ${paint.dim(setup.state)}`
]

/**
 * The formatter for the two screens the tool introduces itself on, with the
 * header above what the default formatter draws, and on the help screen the
 * lines naming this machine's setup under it.
 *
 * The root command is the one whose help document lists subcommands, which is
 * what keeps the header off `dw-mc status --help`.
 */
const formatter = (colors: boolean, setupLines: ReadonlyArray<string>): CliOutput.Formatter => {
  const inner = CliOutput.defaultFormatter({ colors })
  const drawn = header(colors)
  const withSetup = setupLines.length === 0 ? drawn : `${drawn}\n\n${setupLines.join("\n")}`
  return {
    formatHelpDoc: (doc: HelpDoc.HelpDoc) =>
      doc.subcommands === undefined ? inner.formatHelpDoc(doc) : `${withSetup}\n\n${inner.formatHelpDoc(doc)}`,
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
 *
 * The paths are worked out as the layer is built, from the environment alone.
 * The configuration file is read only once `--help` is asked for, because no
 * other run of the tool prints what it says here. A store that fails outright
 * leaves the lines off rather than the help screen.
 */
export const layer: Layer.Layer<never, Config.ConfigError, Stdio.Stdio | ConfigStore | Path.Path> = Layer.unwrap(
  Effect.gen(function* () {
    const colors = yield* screened
    const config = yield* ConfigStore
    const home = Option.getOrUndefined(yield* Config.String("HOME").pipe(Config.option))
    const setup: Setup = { config: tilde(config.path, home), state: tilde(yield* stateDirectory, home) }

    const setupLines = Effect.provideService(registration, ConfigStore, config).pipe(
      Effect.map((said) => described(setup, said, paintFor(colors))),
      Effect.orElseSucceed((): ReadonlyArray<string> => [])
    )
    const introducing = (builtIn: GlobalFlag.Action<boolean>, lines: Effect.Effect<ReadonlyArray<string>>) =>
      GlobalFlag.Action({
        flag: builtIn.flag,
        run: (value, context) =>
          Effect.flatMap(lines, (it) =>
            Effect.provideService(builtIn.run(value, context), CliOutput.Formatter, formatter(colors, it))
          )
      })
    return CliConfig.layer({
      builtIns: CliConfig.defaults.builtIns.map((builtIn) => {
        if (builtIn === GlobalFlag.Help) {
          return introducing(GlobalFlag.Help, setupLines)
        }
        if (builtIn === GlobalFlag.Version) {
          return introducing(GlobalFlag.Version, Effect.succeed([]))
        }
        return builtIn
      })
    })
  })
)
