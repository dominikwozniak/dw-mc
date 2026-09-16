// `Path` from `effect` joins and resolves paths and has no glob matcher. This is
// the platform's own, and matching a `docs_only` glob against a repository path
// reads nothing and decides nothing about this machine.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { matchesGlob } from "node:path"

import { DateTime, Effect, Option, Schema } from "effect"

import { Effort, Runner } from "#adapters/config.ts"
import { storeFor } from "#adapters/store.ts"
import type { Findings } from "#domain/findings.ts"
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
 * Which head a pull request was last reviewed at: an index beside `runKey` and
 * `reportKey` rather than a thing the glossary names.
 *
 * A run is kept under the head it read, which answers the question a sweep asks
 * of one head. The re-run rule and `dw-mc findings` ask the other one - which
 * head the last run was at - and this is where they read it, so neither has to
 * ask GitHub what is current before it can look anything up.
 */
export const LastReviewed = Schema.Struct({ head: Schema.String })
export type LastReviewed = typeof LastReviewed.Type

/** Where that head is kept. No head is spelled `latest`, so nothing collides. */
export const latestKey = (repo: string, number: number): string => `${repo}#${number}@latest`

/**
 * The last review run on a pull request, or none where it has had none.
 *
 * A run this version cannot read is a run another version of this record wrote,
 * and the state directory is a cache of work that can be done again: forgetting
 * it costs one review, where failing here would cost me the command I asked for.
 */
export const lastRun = Effect.fn("review.lastRun")(function* (repo: string, number: number) {
  const heads = yield* storeFor("runs", LastReviewed)
  const at = yield* Effect.orElseSucceed(heads.get(latestKey(repo, number)), () => Option.none<LastReviewed>())
  if (Option.isNone(at)) {
    return Option.none<ReviewRun>()
  }

  const runs = yield* storeFor("runs", ReviewRun)
  return yield* Effect.orElseSucceed(runs.get(runKey(repo, number, at.value.head)), () => Option.none<ReviewRun>())
})

/**
 * What a run reported, or null where it reported nothing at all.
 *
 * A failure is not a clean verdict: a run that could not report has found
 * nothing, which is not the same as having found nothing wrong. Everything that
 * reads a run's findings reads them through here, so the distinction is drawn
 * once rather than at every caller that might forget it.
 */
export const reportedBy = (run: ReviewRun): Findings | null =>
  run.outcome._tag === "reported" ? { verdict: run.outcome.verdict, findings: run.outcome.findings } : null

/**
 * Whether the files changed since the last run are worth paying for another.
 *
 * The question is deliberately about what changed rather than how much: one
 * line outside the `docs_only` globs is code nobody has reviewed, and a
 * thousand lines inside them are still prose.
 */
export const worthRerunning = (changed: ReadonlyArray<string>, docsOnly: ReadonlyArray<string>): boolean =>
  changed.some((file) => !docsOnly.some((glob) => matchesGlob(file, glob)))

/** Everything the re-run rule is allowed to know about the run that was asked for. */
export interface Asked {
  /** The last run on this pull request, or null where it has had none. */
  readonly last: ReviewRun | null
  /** The head the run would cover. */
  readonly head: string
  /** What changed since the last run's head, or null where GitHub would not say. */
  readonly changed: ReadonlyArray<string> | null
}

/**
 * The re-run rule: the head this run is skipped against, or null where it runs.
 *
 * A review costs real money and minutes of my attention, and a typo fix is not
 * worth either. Four things are never skipped, because the rule is here to save
 * me a review and not to stand between me and one I asked for: a pull request
 * with no run behind it, a run that reported nothing, a comparison GitHub would
 * not answer, and anything that changed outside the globs. A head that has
 * already had a run changed nothing at all, which is the one case that needs no
 * comparison to decide.
 */
export const skippedSince = (asked: Asked, docsOnly: ReadonlyArray<string>): string | null => {
  if (asked.last === null || reportedBy(asked.last) === null) {
    return null
  }
  const changed = asked.last.head === asked.head ? [] : asked.changed
  return changed === null || worthRerunning(changed, docsOnly) ? null : asked.last.head
}

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
