import { Command } from "effect/unstable/cli"

import { findings } from "#cli/findings.ts"
import { fix } from "#cli/fix.ts"
import { init } from "#cli/init.ts"
import { picker } from "#cli/pick.ts"
import { rebase } from "#cli/rebase.ts"
import { rerun } from "#cli/rerun.ts"
import { resolve } from "#cli/resolve.ts"
import { review } from "#cli/review.ts"
import { stampCommand } from "#cli/stamp.ts"
import { status } from "#cli/status.ts"
import { sweepCommand } from "#cli/sweep.ts"

export const version = "0.0.0"

/** Where the project lives, printed beside the version in the header. */
export const projectUrl = "github.com/dominikwozniak/dw-mc"

const subcommands = [init, review, findings, fix, rebase, rerun, resolve, sweepCommand, status, stampCommand] as const

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
