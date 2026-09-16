import { Schema, SchemaRepresentation, SchemaTransformation } from "effect"

import { Severity } from "#adapters/config.ts"

/** Whether a review run found anything at all. */
export const Verdict = Schema.Literals(["clean", "findings"])
export type Verdict = typeof Verdict.Type

/**
 * Every severity word a runner may answer with.
 *
 * The first three are ours, and the only ones a runner is asked for. The rest
 * are the persona the `prompt` runner carries, which grades in its own words:
 * a turn that comes back in them is worth reading rather than throwing away.
 */
const Spelling = Schema.Literals(["error", "warning", "info", "Critical", "Required", "Optional", "Nit", "FYI"])

/** What each of those words weighs. The record is exhaustive, so neither list can drift. */
const severityOf: Record<typeof Spelling.Type, Severity> = {
  error: "error",
  warning: "warning",
  info: "info",
  Critical: "error",
  Required: "error",
  Optional: "warning",
  Nit: "info",
  FYI: "info"
}

const Weighed = Spelling.pipe(
  Schema.decodeTo(
    Severity,
    SchemaTransformation.transform({
      decode: (word: typeof Spelling.Type) => severityOf[word],
      encode: (severity: Severity): typeof Spelling.Type => severity
    })
  )
)

/** The fields both spellings of a finding share. Only the severity differs. */
const shared = { file: Schema.String, line: Schema.Int, summary: Schema.String }

/** One problem a review run reports, at a file and line. */
export const Finding = Schema.Struct({ ...shared, severity: Severity })
export type Finding = typeof Finding.Type

/**
 * What a review run found: the shape the tool keeps, and the one a fix session
 * is later handed.
 */
export const Findings = Schema.Struct({
  verdict: Verdict,
  findings: Schema.Array(Finding)
})
export type Findings = typeof Findings.Type

/**
 * The same findings as a runner may spell them, which is what the second turn's
 * output is read with.
 *
 * A word nothing maps fails here, and a failed read is a failure of the run:
 * findings the tool cannot weigh are not findings it can act on.
 */
export const Reported = Schema.Struct({
  verdict: Verdict,
  findings: Schema.Array(Schema.Struct({ ...shared, severity: Weighed }))
})

/**
 * The schema every runner must satisfy, as the JSON Schema a runner is handed.
 *
 * It is derived from the schema the findings are kept under rather than written
 * out beside it, so a runner is asked for exactly the shape that is persisted.
 * `Reported` is wider on purpose and only on the severity: what a runner is
 * asked for is our three words, and a persona's five are read where they arrive
 * anyway rather than being asked for.
 */
export const jsonSchema: string = JSON.stringify(
  SchemaRepresentation.toJsonSchemaDocument(SchemaRepresentation.toRepresentation(Findings.ast)).schema
)

/** Where each severity sits against the others, so the bar can be compared with it. */
const rank: Record<Severity, number> = { info: 0, warning: 1, error: 2 }

/**
 * The findings that withhold the stamp: everything at `blocksOn` or above it.
 *
 * `stamp.blocks_on` is my bar rather than a constant, so a repository whose
 * warnings I do not want to merge past is configured rather than coded. An
 * error blocks wherever the bar is, because nothing weighs more than one.
 */
export const blocking = (findings: ReadonlyArray<Finding>, blocksOn: Severity): ReadonlyArray<Finding> =>
  findings.filter((finding) => rank[finding.severity] >= rank[blocksOn])
