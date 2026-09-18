import { Console, Effect, Schema } from "effect"
import { CliError, Command, Flag } from "effect/unstable/cli"

import { asUserError } from "#cli/exit.ts"
import { currentRun, forPr, prArgument } from "#cli/pr.ts"
import { rule } from "#cli/row.ts"
import { count, table } from "#cli/table.ts"
import type { Findings } from "#domain/findings.ts"
import { blocking, Findings as FindingsSchema } from "#domain/findings.ts"
import type { ReviewRun } from "#domain/review.ts"
import { reportedBy, short } from "#domain/review.ts"
import type { Severity } from "#terms/review.ts"

/** The findings as the JSON the schema defines, rather than as this file spells it. */
const asJson = Schema.encodeEffect(Schema.fromJsonString(FindingsSchema))

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print the findings as the JSON a fix session is handed")
)

/** What a run's findings come to in one line, against the bar that blocks. */
export const summary = (found: Findings, blocksOn: Severity): string => {
  if (found.findings.length === 0) {
    return "clean, nothing to fix"
  }
  const blocked = blocking(found.findings, blocksOn).length
  return `${count(found.findings.length, "finding")}, ${blocked} blocking`
}

/** Which run these findings are, and what they come to: the line above the list. */
export const header = (run: ReviewRun, found: Findings, blocksOn: Severity): string =>
  `${run.repo}#${run.number}  ${short(run.head)}  ${summary(found, blocksOn)}`

/**
 * The findings one to a line, in the order the run reported them, ruled so the
 * three columns read apart.
 */
export const lines = (found: Findings): ReadonlyArray<string> =>
  table(
    found.findings.map((finding) => [`${finding.file}:${finding.line}`, finding.severity, finding.summary]),
    rule
  )

/**
 * What the run reported, or the sentence saying it reported nothing at all.
 *
 * A run that failed is not a clean one: a pipe must never be handed "no
 * findings" when what happened is that nothing could be read.
 */
export const whatItFound = (run: ReviewRun): Effect.Effect<Findings, CliError.UserError> => {
  const found = reportedBy(run)
  return found === null
    ? Effect.fail(
        new CliError.UserError({
          cause:
            `The review run on ${short(run.head)} reported no findings: ` +
            `${run.outcome._tag === "failed" ? run.outcome.detail : ""}\n` +
            `Run dw-mc review ${run.number} --force to run it again.`
        })
      )
    : Effect.succeed(found)
}

/**
 * What the current review run found, as a table or as the JSON it is kept in.
 *
 * `--json` is the whole point of the command: it prints the findings and
 * nothing else, so I can pipe them anywhere, and a fix session inside an open
 * agent reads exactly what the tool recorded rather than a retelling of it.
 *
 * A run that failed prints no findings and fails: a review run that could not
 * report has found nothing, which is not the same as having found nothing
 * wrong, and a pipe must never be handed the second when the first is true.
 */
export const findings = Command.make(
  "findings",
  { pr: prArgument, json: jsonFlag },
  Effect.fn("findings")(
    function* ({ json, pr }) {
      const { number, repo, settings } = yield* forPr(pr)

      const run = yield* currentRun(repo, number)
      const found = yield* whatItFound(run)
      if (json) {
        yield* Console.log(yield* asJson(found))
        return
      }

      yield* Console.log(header(run, found, settings.stamp.blocks_on))
      for (const line of lines(found)) {
        yield* Console.log(`  ${line}`)
      }
    },
    Effect.catchTag(["ConfigMalformed"], asUserError)
  )
).pipe(Command.withDescription("Print what the current review run found on one pull request"))
