import { Console, DateTime, Effect, Schema } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import { Paint } from "#adapters/paint.ts"
import { prKey } from "#adapters/store.ts"
import { asUserError, userFacing } from "#cli/exit.ts"
import { cells, heading, reference, rule, titleWidth } from "#cli/row.ts"
import { allFlag, askedOf, printLeftOut, printTroubles, repoFlag, sweep, sweeping } from "#cli/sweep.ts"
import { table } from "#cli/table.ts"
import type { Grouped, Placed } from "#domain/bucket.ts"
import { Bucket, Facts, group } from "#domain/bucket.ts"
import type { Asked } from "#domain/coverage.ts"
import { stampedAmong } from "#domain/stamp.ts"
import type { Since } from "#domain/watermark.ts"
import { markShown, sinceShown } from "#domain/watermark.ts"

/** What moved a row, as the JSON says it: `from` is null where the row kept its bucket. */
const SinceJson = Schema.Union([
  Schema.TaggedStruct("new", {}),
  Schema.TaggedStruct("still", {}),
  Schema.TaggedStruct("moved", { from: Schema.NullOr(Bucket), what: Schema.Array(Schema.String) })
])

/**
 * One pass of `dw-mc status`, as the JSON a machine reads it in.
 *
 * A row carries every fact flat beside its placement, so `jq` reaches
 * `.prs[].checks` without unwrapping anything. What the table says in lines
 * after it - what the pass could not read, and how many registered
 * repositories it left out - is here as well, because a document without them
 * reads as the whole picture when it is not.
 */
export const StatusJson = Schema.Struct({
  /** When the pass ended: status sweeps on every run. */
  sweptAt: Schema.DateTimeUtcFromString,
  repos: Schema.Array(Schema.String),
  leftOut: Schema.Int,
  prs: Schema.Array(
    Schema.Struct({
      bucket: Bucket,
      reason: Schema.String,
      stamped: Schema.Boolean,
      since: SinceJson,
      ...Facts.fields
    })
  ),
  troubles: Schema.Array(Schema.Struct({ where: Schema.String, detail: Schema.String }))
})

const asJson = Schema.encodeEffect(Schema.fromJsonString(StatusJson))

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print the pass as JSON, for jq or an agent session, and leave what I last looked at alone")
)

const sinceJson = (since: Since): typeof SinceJson.Type =>
  since._tag === "moved" ? { _tag: "moved", from: since.from ?? null, what: since.what } : since

/**
 * The pass as one JSON document, and nothing else on stdout.
 *
 * It sweeps without a heartbeat, because what reads this is a pipe or a
 * session, and a line drawn over the document is a document broken. What moved
 * is read and never written: a machine reading the pass is not me looking, so
 * the watermark stays where the last table left it.
 */
const printJson = Effect.fn("status.json")(function* (asked: Asked) {
  const report = yield* sweep(asked, () => Effect.void)
  const sweptAt = yield* DateTime.now
  const placed = group(report.facts).flatMap((it) => it.placed)
  const stamped = yield* stampedAmong(report.facts)
  const sinceOf = yield* sinceShown(placed)
  yield* Console.log(
    yield* asJson({
      sweptAt,
      repos: report.repos,
      leftOut: report.leftOut,
      prs: placed.map((it) => ({
        bucket: it.placement.bucket,
        reason: it.placement.reason,
        stamped: stamped.has(prKey(it.facts.repo, it.facts.number)),
        since: sinceJson(sinceOf(it)),
        ...it.facts
      })),
      troubles: report.troubles
    })
  )
})

/** What moved a row, said on its own line above the group it now sits in. */
const movement = (placed: Placed, since: Since): ReadonlyArray<string> => {
  if (since._tag !== "moved") {
    return []
  }
  const from = since.from === undefined ? "" : ` from ${heading[since.from]}`
  const what = since.what.length === 0 ? "" : `: ${since.what.join(", ")}`
  return [`  ↳ ${reference(placed.facts)}${from}${what}`]
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
  sinceOf: (placed: Placed) => Since,
  paint: Paint
): ReadonlyArray<string> => {
  const rows = table(
    grouped.flatMap((it) =>
      it.placed.map((placed) =>
        cells(
          placed,
          stamped.has(prKey(placed.facts.repo, placed.facts.number)),
          sinceOf(placed),
          titleWidth,
          paint,
          "marker"
        )
      )
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
 * `--json` prints the same pass for a machine.
 */
export const status = Command.make(
  "status",
  { repo: repoFlag, all: allFlag, json: jsonFlag },
  Effect.fn("status")(
    function* (flags) {
      if (flags.json) {
        yield* printJson(askedOf(flags))
        return
      }
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
      for (const line of lines(grouped, yield* stampedAmong(report.facts), yield* sinceShown(shown), yield* Paint)) {
        yield* Console.log(line)
      }
      yield* printLeftOut(report)
      yield* printTroubles(report.troubles)
      yield* markShown(shown)
    },
    Effect.catchTag(userFacing, asUserError)
  )
).pipe(
  Command.withDescription(
    "Show which bucket every tracked pull request of the repository I stand in, or of every one, sits in, which ones I have stamped, and what moved since I last looked"
  )
)
