import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { init } from "./init.ts"

export const version = "0.0.0"

export const dwMc = Command.make(
  "dw-mc",
  {},
  Effect.fn(function*() {
    yield* Console.log("dw-mc: no commands yet. See docs/v1-design.md for the build order.")
  })
).pipe(
  Command.withDescription(
    "Keeps the state of my open pull requests on disk and shows what every PR waits on"
  ),
  Command.withSubcommands([init])
)
