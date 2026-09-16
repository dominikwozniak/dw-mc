import { DateTime, Schema } from "effect"

import { Effort, Runner } from "#adapters/config.ts"

/**
 * One execution of a runner against a tracked PR at a specific head commit.
 *
 * It is a schema because a review run outlives the command that started it: the
 * state directory is where the next sweep learns that this head has been
 * reviewed, and where the follow-up turn finds the session to resume.
 */
export const ReviewRun = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int,
  /** The head the run covers. A run never vouches for code it did not see. */
  head: Schema.String,
  runner: Runner,
  effort: Effort,
  /** The agent session the report came out of, which the follow-up turn resumes. */
  sessionId: Schema.String,
  ranAt: Schema.DateTimeUtcFromString
})
export type ReviewRun = typeof ReviewRun.Type

/**
 * Where a run is kept: one key per head, so a run and the code it read cannot
 * drift apart, and a re-review of the same head replaces the run before it.
 */
export const runKey = (repo: string, number: number, head: string): string => `${repo}#${number}@${head}`

/** Where the run's report is kept: beside the run, as the Markdown it is. */
export const reportKey = (repo: string, number: number, head: string): string => `${runKey(repo, number, head)}.md`

/**
 * The report as it is written down: what it is of, then what the runner said.
 *
 * The heading is the whole point of writing it rather than storing the prose
 * alone - a file found months later says which pull request, which commit and
 * how much the run spent, without anything else having to be open.
 */
export const reportDocument = (run: ReviewRun, title: string, prose: string): string =>
  [
    `# ${run.repo}#${run.number} ${title}`,
    "",
    `- head: ${run.head}`,
    `- runner: ${run.runner}, effort ${run.effort}`,
    `- ran: ${DateTime.formatIso(run.ranAt)}`,
    "",
    prose.trim(),
    ""
  ].join("\n")
