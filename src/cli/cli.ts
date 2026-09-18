import type { Config, PlatformError } from "effect"
import { ConfigProvider, FileSystem, Layer, Path, Stdio, Terminal } from "effect"
import { Command } from "effect/unstable/cli"
import type { KeyValueStore } from "effect/unstable/persistence"
import type { ChildProcessSpawner } from "effect/unstable/process"

import { ConfigStore } from "#adapters/config.ts"
import { layerScripted } from "#adapters/picker.ts"
import * as Store from "#adapters/store.ts"
import { cleanup } from "#cli/cleanup.ts"
import { comments } from "#cli/comments.ts"
import { findings } from "#cli/findings.ts"
import { fix } from "#cli/fix.ts"
import { init } from "#cli/init.ts"
import { merge } from "#cli/merge.ts"
import { picker } from "#cli/pick.ts"
import { rebase } from "#cli/rebase.ts"
import { rerun } from "#cli/rerun.ts"
import { resolve } from "#cli/resolve.ts"
import { review } from "#cli/review.ts"
import { stampCommand } from "#cli/stamp.ts"
import { status } from "#cli/status.ts"
import { sweepCommand } from "#cli/sweep.ts"
import { uninstall } from "#cli/uninstall.ts"

declare const __VERSION__: string | undefined

/**
 * The version the CLI reports: the build stamps it in from `package.json`.
 *
 * Running from source leaves the constant undeclared rather than undefined, so
 * the check has to be `typeof` and the fallback is what a test reads.
 */
export const version: string = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0"

/** Where the project lives, printed beside the version in the header. */
export const projectUrl = "github.com/dominikwozniak/dw-mc"

const subcommands = [
  init,
  review,
  comments,
  findings,
  fix,
  rebase,
  rerun,
  resolve,
  merge,
  sweepCommand,
  status,
  stampCommand,
  cleanup,
  uninstall
] as const

/**
 * The same subcommands under a root that opens no picker, which is what the
 * picker dispatches into.
 *
 * It exists so that what the picker runs is the command I would have typed,
 * parsed by the parser that would have parsed it. Dispatching into `dwMc`
 * itself would be the command referring to its own definition, and a picker
 * that reached its own root with no arguments would open a second picker.
 */
const dispatcher = Command.make("dw-mc").pipe(Command.withSubcommands(subcommands))

export const dwMc = Command.make("dw-mc", {}, picker(Command.runWith(dispatcher, { version }))).pipe(
  Command.withDescription("Keeps the state of my open pull requests on disk and shows what every PR waits on"),
  Command.withSubcommands(subcommands)
)

/**
 * Everything a command runs on in a test, said as the few things a test varies.
 *
 * Only the spawner is named every time, because what a command reaches for is
 * the whole question a command's test asks. Every other seam answers the way
 * this machine does when nothing is wrong with it.
 */
export interface Machine {
  /** The programs the run may spawn, and what each of them answers. */
  readonly spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>
  /** What the keyboard answers a prompt with, in the order it is typed. */
  readonly keys?: ReadonlyArray<Terminal.UserInput> | undefined
  /** Where what a prompt draws in place is collected, for a test that reads it. */
  readonly drawn?: Array<string> | undefined
  /** How wide the screen is. Zero is a pipe, where nothing is drawn in place. */
  readonly columns?: number | undefined
  /** The environment the run reads its directories out of. */
  readonly env?: Record<string, string | undefined> | undefined
  /** The disk, where a test needs a real one under a temporary home. */
  readonly fileSystem?: Layer.Layer<FileSystem.FileSystem> | undefined
  /** The state directory, where a test needs the real one or one that refuses. */
  readonly state?:
    | Layer.Layer<
        KeyValueStore.KeyValueStore,
        Config.ConfigError | PlatformError.PlatformError,
        FileSystem.FileSystem | Path.Path
      >
    | undefined
}

/**
 * The machine one run of the CLI stands on in a test: a fake spawner, an
 * in-memory configuration file, an in-memory state directory and a terminal
 * that answers from a script.
 *
 * It is the assembly `src/cli/bin.ts` makes, with a double at every seam, and
 * it lives here beside the command the two of them run. A command's test that
 * builds its own is one more answer to the question of what this tool talks
 * to, and the stack is the one place that question has one.
 */
export const machineOf = (options: Machine) =>
  Layer.provideMerge(
    Layer.mergeAll(ConfigStore.layerTest, options.state ?? Store.layerTest),
    Layer.mergeAll(
      ConfigProvider.layer(ConfigProvider.fromEnvRecord(options.env ?? { HOME: "/home/dw" })),
      options.fileSystem ?? FileSystem.layerNoop({}),
      Path.layer,
      Stdio.layerTest({}),
      options.spawner,
      layerScripted(options.keys ?? [], options.drawn, options.columns)
    )
  )

/** Runs `dw-mc` over `argv`, the way the binary runs it. */
export const run = (...argv: ReadonlyArray<string>) => Command.runWith(dwMc, { version })(argv)
