import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"

import { findings } from "#cli/findings.ts"
import { init } from "#cli/init.ts"
import { review } from "#cli/review.ts"
import { stampCommand } from "#cli/stamp.ts"
import { status } from "#cli/status.ts"
import { sweepCommand } from "#cli/sweep.ts"

export const version = "0.0.0"

/** Where the project lives, printed beside the version in the header. */
export const projectUrl = "github.com/dominikwozniak/dw-mc"

export const dwMc = Command.make(
  "dw-mc",
  {},
  Effect.fn(function* () {
    yield* Console.log("dw-mc: no commands yet. See docs/v1-design.md for the build order.")
  })
).pipe(
  Command.withDescription("Keeps the state of my open pull requests on disk and shows what every PR waits on"),
  Command.withSubcommands([init, review, findings, sweepCommand, status, stampCommand])
)
