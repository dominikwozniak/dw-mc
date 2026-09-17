import { Effect, Schema } from "effect"

import { Finding } from "#domain/findings.ts"
import { short } from "#domain/review.ts"

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
 * finding it is on: the finding is what the review thought, the note is what I
 * think, and I am the one who picked it.
 *
 * Pushing is mine either way, and `commits` says whether committing is too.
 * The tool itself never commits and never pushes; what the session may do
 * inside the worktree is my call, made once in `fix.commits` or for one session
 * with the flag.
 */
export const promptFor = (selection: Selection, commits: boolean): Effect.Effect<string, Schema.SchemaError> =>
  Effect.map(asJson(selection), (json) =>
    [
      `These are the findings I picked from a dw-mc review run on ${selection.repo}#${selection.number}, ` +
        `at ${short(selection.head)}, the commit their lines are counted from.`,
      `Work through them one at a time. Where a finding carries a note, the note is mine and outranks the ` +
        `finding's own summary; where it carries none, the summary is the whole brief.`,
      commits
        ? `Commit what you change, one logical change to a commit. Do not push: I read the commits and push them myself.`
        : `Do not commit and do not push: I do both myself when I have read what you changed.`,
      json
    ].join("\n\n")
  )

/**
 * Why these findings cannot be fixed where the pull request now is, or nothing
 * where they can.
 *
 * A pull request that moved since its last review run has findings at lines
 * that may no longer be there, and a worktree cut at the new head would carry
 * them into code they were never about. Reviewing again is cheap next to fixing
 * the wrong thing.
 */
export const staleAt = (number: number, run: string, now: string): string | null =>
  run === now
    ? null
    : `The findings are from ${short(run)} and the pull request is now at ${short(now)}. ` +
      `Run dw-mc review ${number} again to review the head you would be fixing.`
