import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"

import { Paint } from "#adapters/paint.ts"
import { prKey } from "#adapters/store.ts"
import { asUserError, userFacing } from "#cli/exit.ts"
import { cells, heading, rule, titleWidth } from "#cli/row.ts"
import { allFlag, askedOf, printLeftOut, printTroubles, repoFlag, sweeping } from "#cli/sweep.ts"
import { table } from "#cli/table.ts"
import type { Grouped } from "#domain/bucket.ts"
import { group } from "#domain/bucket.ts"
import { stampedAmong } from "#domain/stamp.ts"

/**
 * Every tracked PR under the bucket it sits in, in the order I act on them.
 *
 * The rows of every bucket are measured together, so the columns line up down
 * the whole table rather than restarting under each heading, and they are ruled
 * apart: three columns of prose run into one another without a rule, and the
 * middle one is a commit subject that can end in anything.
 */
const lines = (grouped: ReadonlyArray<Grouped>, stamped: ReadonlySet<string>, paint: Paint): ReadonlyArray<string> => {
  const rows = table(
    grouped.flatMap((it) =>
      it.placed.map((placed) =>
        cells(placed, stamped.has(prKey(placed.facts.repo, placed.facts.number)), titleWidth, paint, "marker")
      )
    ),
    rule
  )
  let taken = 0
  return grouped.flatMap((it, index) => {
    const mine = rows.slice(taken, taken + it.placed.length)
    taken += it.placed.length
    return [...(index === 0 ? [] : [""]), heading[it.bucket], ...mine.map((row) => `  ${row}`)]
  })
}

/**
 * The table of what every tracked PR waits on.
 *
 * It sweeps first, every time: a table I read is never one I forgot to refresh.
 */
export const status = Command.make(
  "status",
  { repo: repoFlag, all: allFlag },
  Effect.fn("status")(
    function* (flags) {
      const report = yield* sweeping(askedOf(flags))

      if (report.repos.length === 0) {
        yield* Console.log("No repositories registered. Run dw-mc init inside a repository to register it.")
        return
      }

      const grouped = group(report.facts)
      if (grouped.length === 0) {
        yield* Console.log("No open pull requests.")
      }
      for (const line of lines(grouped, yield* stampedAmong(report.facts), yield* Paint)) {
        yield* Console.log(line)
      }
      yield* printLeftOut(report)
      yield* printTroubles(report.troubles)
    },
    Effect.catchTag(userFacing, asUserError)
  )
).pipe(
  Command.withDescription(
    "Show which bucket every tracked pull request of the repository I stand in, or of every one, sits in, and which ones I have stamped"
  )
)
