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

/** Where a finding is, and what it says. Only how much it weighs is spelled two ways. */
const at = { file: Schema.String, line: Schema.Int, summary: Schema.String }

/** One problem a review run reports, at a file and line. */
export const Finding = Schema.Struct({ ...at, severity: Severity })
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
  findings: Schema.Array(Schema.Struct({ ...at, severity: Weighed }))
})

/**
 * The schema every runner must satisfy, as the JSON Schema a runner is handed.
 *
 * It is derived from the schema the findings are kept under rather than written
 * out beside it: what the runner is asked for and what the tool will accept are
 * then the same thing by construction.
 */
export const jsonSchema: string = JSON.stringify(
  SchemaRepresentation.toJsonSchemaDocument(SchemaRepresentation.toRepresentation(Findings.ast)).schema
)

/** The findings that withhold the stamp: an error is a blocking finding. */
export const blocking = (findings: ReadonlyArray<Finding>): ReadonlyArray<Finding> =>
  findings.filter((finding) => finding.severity === "error")
