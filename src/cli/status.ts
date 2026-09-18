import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"

import { Paint } from "#adapters/paint.ts"
import { prKey } from "#adapters/store.ts"
import { asUserError, userFacing } from "#cli/exit.ts"
import { cells, gutter, heading, rule, titleWidth } from "#cli/row.ts"
import { allFlag, askedOf, printLeftOut, printTroubles, repoFlag, sweeping } from "#cli/sweep.ts"
import { table } from "#cli/table.ts"
import type { Grouped, Placed } from "#domain/bucket.ts"
import { group } from "#domain/bucket.ts"
import { stampedAmong } from "#domain/stamp.ts"
import type { Since } from "#domain/watermark.ts"
import { sinceAmong, watermark } from "#domain/watermark.ts"

const keyOf = (placed: Placed): string => prKey(placed.facts.repo, placed.facts.number)

/** What moved a row, said on its own line above the group it now sits in. */
const movement = (placed: Placed, since: Since): ReadonlyArray<string> => {
  if (since._tag !== "moved") {
    return []
  }
  const from = since.from === undefined ? "" : ` from ${heading[since.from]}`
  const what = since.what.length === 0 ? "" : `: ${since.what.join(", ")}`
  return [`  ↳ ${placed.facts.repo}#${placed.facts.number}${from}${what}`]
}

/**
 * Every tracked PR under the bucket it sits in, in the order I act on them.
 *
 * The rows of every bucket are measured together, so the columns line up down
 * the whole table rather than restarting under each heading, and they are ruled
 * apart: three columns of prose run into one another without a rule, and the
 * middle one is a commit subject that can end in anything.
 *
 * What moved since I last looked is marked in the gutter the rows are indented
 * by, so a mark costs no column and a row with none reads as it always did.
 */
const lines = (
  grouped: ReadonlyArray<Grouped>,
  stamped: ReadonlySet<string>,
  seen: ReadonlyMap<string, Since>,
  paint: Paint
): ReadonlyArray<string> => {
  const sinceOf = (placed: Placed): Since => seen.get(keyOf(placed)) ?? { _tag: "unseen" }
  const rows = table(
    grouped.flatMap((it) =>
      it.placed.map((placed) => {
        const [lead = "", ...rest] = cells(placed, stamped.has(keyOf(placed)), titleWidth, paint, "marker")
        return [`${gutter[sinceOf(placed)._tag]} ${lead}`, ...rest]
      })
    ),
    rule
  )
  let taken = 0
  return grouped.flatMap((it, index) => {
    const mine = rows.slice(taken, taken + it.placed.length)
    taken += it.placed.length
    return [
      ...(index === 0 ? [] : [""]),
      heading[it.bucket],
      ...it.placed.flatMap((placed) => movement(placed, sinceOf(placed))),
      ...mine
    ]
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
      const shown = grouped.flatMap((it) => it.placed)
      const seen = yield* sinceAmong(shown)
      for (const line of lines(grouped, yield* stampedAmong(report.facts), seen, yield* Paint)) {
        yield* Console.log(line)
      }
      yield* watermark(shown)
      yield* printLeftOut(report)
      yield* printTroubles(report.troubles)
    },
    Effect.catchTag(userFacing, asUserError)
  )
).pipe(
  Command.withDescription(
    "Show which bucket every tracked pull request of the repository I stand in, or of every one, sits in, which ones I have stamped, and what moved since I last looked"
  )
)
