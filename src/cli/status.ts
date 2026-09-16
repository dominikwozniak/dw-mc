import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"

import { asUserError, printTroubles, sweep, userFacing } from "#cli/sweep.ts"
import { table, truncate } from "#cli/table.ts"
import type { Bucket, Grouped, Placed } from "#domain/bucket.ts"
import { factsKey, group } from "#domain/bucket.ts"
import { stampedAmong } from "#domain/stamp.ts"

/** The glossary's name for each bucket, which is what the heading says. */
const heading: Record<Bucket, string> = {
  "needs-me": "Needs me",
  "needs-review-run": "Needs review run",
  "waiting-on-others": "Waiting on others",
  ready: "Ready"
}

/** Long enough for a conventional-commit subject, short enough to keep a row on one line. */
const titleWidth = 56

/**
 * One row: which pull request, what it is, and what it waits on.
 *
 * A stamp is a mark beside the pull request rather than a column of its own, so
 * a table where nothing is stamped is exactly the table it was before: the
 * stamp is a thing I look for, not a thing I read every row of.
 */
const cells = (placed: Placed, stamped: boolean): ReadonlyArray<string> => [
  `${placed.facts.repo}#${placed.facts.number}${placed.facts.draft ? " (draft)" : ""}${stamped ? " ✓" : ""}`,
  truncate(placed.facts.title, titleWidth),
  placed.placement.reason
]

/**
 * Every tracked PR under the bucket it sits in, in the order I act on them.
 *
 * The rows of every bucket are measured together, so the columns line up down
 * the whole table rather than restarting under each heading.
 */
const lines = (grouped: ReadonlyArray<Grouped>, stamped: ReadonlySet<string>): ReadonlyArray<string> => {
  const rows = table(
    grouped.flatMap((it) =>
      it.placed.map((placed) => cells(placed, stamped.has(factsKey(placed.facts.repo, placed.facts.number))))
    )
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
  {},
  Effect.fn("status")(
    function* () {
      const report = yield* sweep

      if (report.repos.length === 0) {
        yield* Console.log("No repositories registered. Run dw-mc init inside a repository to register it.")
        return
      }

      const grouped = group(report.facts)
      if (grouped.length === 0) {
        yield* Console.log("No open pull requests.")
      }
      for (const line of lines(grouped, yield* stampedAmong(report.facts))) {
        yield* Console.log(line)
      }
      yield* printTroubles(report.troubles)
    },
    Effect.catchTag(userFacing, asUserError)
  )
).pipe(Command.withDescription("Show which bucket every tracked pull request sits in, and which ones I have stamped"))
