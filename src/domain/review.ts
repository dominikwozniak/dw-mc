// `Path` from `effect` joins and resolves paths and has no glob matcher. This is
// the platform's own, and matching a `docs_only` glob against a repository path
// reads nothing and decides nothing about this machine.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { matchesGlob } from "node:path"

import { DateTime, Schema } from "effect"

import { Effort, Runner } from "#adapters/config.ts"
import { Finding, Verdict } from "#domain/findings.ts"

/**
 * What a review run came to, which is what its second turn reported.
 *
 * A failure is recorded as one and is never a clean verdict: a turn that exited
 * badly, ran out of patience or answered in a shape that does not validate has
 * found nothing, which is not the same as having found nothing wrong.
 */
export const Outcome = Schema.Union([
  Schema.TaggedStruct("reported", { verdict: Verdict, findings: Schema.Array(Finding) }),
  Schema.TaggedStruct("failed", { detail: Schema.String })
])
export type Outcome = typeof Outcome.Type

/**
 * One execution of a runner against a tracked PR at a specific head commit.
 *
 * It is a schema because a review run outlives the command that started it: the
 * state directory is where the next sweep learns that this head has been
 * reviewed, and where a fix session finds what there is to fix.
 */
export const ReviewRun = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int,
  /** The head the run covers. A run never vouches for code it did not see. */
  head: Schema.String,
  runner: Runner,
  effort: Effort,
  /** The agent session the report came out of, which the follow-up turn resumed. */
  sessionId: Schema.String,
  ranAt: Schema.DateTimeUtcFromString,
  outcome: Outcome
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
 * Which head a pull request was last reviewed at.
 *
 * A run is kept under the head it read, which answers the question a sweep asks
 * of one head. The re-run rule and `dw-mc findings` ask the other one - which
 * head the last run was at - and this is where they read it, so neither has to
 * ask GitHub what is current before it can look anything up.
 */
export const Latest = Schema.Struct({ head: Schema.String })
export type Latest = typeof Latest.Type

/** Where that head is kept. No head is spelled `latest`, so nothing collides. */
export const latestKey = (repo: string, number: number): string => `${repo}#${number}@latest`

/**
 * The re-run rule: whether the files changed since the last run are worth
 * paying for another one.
 *
 * A review costs real money and minutes of my attention, and a typo fix is not
 * worth either. The rule is deliberately about what changed rather than how
 * much: one line outside the `docs_only` globs is code nobody has reviewed, and
 * a thousand lines inside them are still prose.
 */
export const worthRerunning = (changed: ReadonlyArray<string>, docsOnly: ReadonlyArray<string>): boolean =>
  changed.some((file) => !docsOnly.some((glob) => matchesGlob(file, glob)))

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

/**
 * The runner a review run executes on, or null while none of the configured
 * ones is built.
 *
 * `builtin` is the only runner there is so far. A repository configured for
 * another is told so rather than quietly reviewed on this one: which runner
 * read the code is half of what a review run means.
 */
export const runnerFor = (runners: ReadonlyArray<Runner>): Runner | null =>
  runners.includes("builtin") ? "builtin" : null
