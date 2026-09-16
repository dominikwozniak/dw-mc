import { Effect, Schema } from "effect"

import { Finding } from "#domain/findings.ts"

/** One finding I chose to act on, carrying what I think about it. */
export const Chosen = Schema.Struct({ ...Finding.fields, note: Schema.optionalKey(Schema.String) })
export type Chosen = typeof Chosen.Type

/**
 * What a fix session is handed: the findings I picked, and the review run they
 * came from.
 *
 * The head is in it because a fix session opens on the commit that was
 * reviewed, and a finding's line means nothing away from it.
 */
export const Selection = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int,
  head: Schema.String,
  findings: Schema.Array(Chosen)
})
export type Selection = typeof Selection.Type

/** The selection as the JSON the schema defines, rather than as this file spells it. */
const asJson = Schema.encodeEffect(Schema.fromJsonString(Selection))

/**
 * The prompt a fix session opens on: what these findings are, and the findings
 * themselves as JSON.
 *
 * The findings go in verbatim rather than described, because a re-description
 * is where a file, a line or my own note quietly changes. A note outranks the
 * finding it is on: the finding is what a runner thought, the note is what I
 * think, and I am the one who picked it.
 *
 * Committing and pushing stay mine. The tool reports and never fixes, and a
 * session that commits on my behalf turns a report into a change I did not
 * read.
 */
export const promptFor = (selection: Selection): Effect.Effect<string, Schema.SchemaError> =>
  Effect.map(asJson(selection), (json) =>
    [
      `These are the findings I picked from a dw-mc review run on ${selection.repo}#${selection.number}, ` +
        `at ${selection.head.slice(0, 7)}, which is the commit this worktree stands on.`,
      `Work through them one at a time. Where a finding carries a note, the note is mine and outranks the ` +
        `finding's own summary; where it carries none, the summary is the whole brief.`,
      `Do not commit and do not push: I do both myself when I have read what you changed.`,
      json
    ].join("\n\n")
  )
