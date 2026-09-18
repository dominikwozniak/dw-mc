// `Path` from `effect` joins and resolves paths and has no glob matcher. This is
// the platform's own, and matching a `docs_only` glob against a repository path
// reads nothing and decides nothing about this machine.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { matchesGlob } from "node:path"

import { DateTime, Effect, Option, Schema } from "effect"

import { prKey, remembered, storeFor } from "#adapters/store.ts"
import type { Findings } from "#domain/findings.ts"
import { blocking, Finding, Verdict } from "#domain/findings.ts"
import type { Severity } from "#terms/review.ts"
import { Effort } from "#terms/review.ts"

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
 * One review run against a tracked PR at a specific head commit.
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
  /**
   * The slash command line the run opened on, or null where it opened on the
   * tool's own prompt. A report found months later says what it was asked, and a
   * record an earlier version wrote carries no such field and is forgotten.
   */
  command: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Effort),
  /**
   * The agent session the run happened in, or null where it never reached one.
   *
   * A run that would not start or exited before it said anything has no session,
   * and the run is still recorded: a failure is recorded as what it is.
   */
  sessionId: Schema.NullOr(Schema.String),
  ranAt: Schema.DateTimeUtcFromString,
  outcome: Outcome
})
export type ReviewRun = typeof ReviewRun.Type

/** A head as it is read out loud: the seven characters git itself abbreviates to. */
export const short = (head: string): string => head.slice(0, 7)

/**
 * Where a run is kept: one key per head, so a run and the code it read cannot
 * drift apart, and a re-review replaces the run before it.
 */
export const runKey = (repo: string, number: number, head: string): string => `${prKey(repo, number)}@${head}`

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
export const latestKey = (repo: string, number: number): string => `${prKey(repo, number)}@latest`

/**
 * The run at one head, or none where nothing has reviewed it.
 *
 * A head is where the question is asked - the stamp, the bucket and `dw-mc
 * findings` all ask about one commit - and one read off the disk answers it
 * without an index to keep in step.
 *
 * Forgetting a run costs one review.
 */
export const runAt = Effect.fn("review.runAt")(function* (repo: string, number: number, head: string) {
  const runs = yield* storeFor("runs", ReviewRun)
  return yield* remembered(runs.get(runKey(repo, number, head)))
})

/** The last review run on a pull request, or none where it has had none. */
export const lastRun = Effect.fn("review.lastRun")(function* (repo: string, number: number) {
  const heads = yield* storeFor("runs", LastReviewed)
  const at = yield* remembered(heads.get(latestKey(repo, number)))
  return Option.isNone(at) ? Option.none<ReviewRun>() : yield* runAt(repo, number, at.value.head)
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
 * Why a run reported nothing, or null where it reported.
 *
 * The sibling of `reportedBy`, and here for the same reason: the two halves of
 * an outcome are read through one place each rather than re-narrowed at every
 * caller.
 */
export const detailOf = (run: ReviewRun): string | null => (run.outcome._tag === "failed" ? run.outcome.detail : null)

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

/** What a run was opened on, as the report says it. */
export const askedOf = (run: ReviewRun): string =>
  run.command === null ? "the tool's own prompt" : [run.command, run.effort].filter((part) => part !== null).join(" ")

/**
 * The report as it is written down: what it is of, then what the run said.
 *
 * The heading is the whole point of writing it rather than storing the prose
 * alone - a file found months later says which pull request, which commit and
 * what the run was asked, without anything else having to be open.
 */
export const reportDocument = (run: ReviewRun, title: string, prose: string): string =>
  [
    `# ${run.repo}#${run.number} ${title}`,
    "",
    `- head: ${run.head}`,
    `- run: ${askedOf(run)}`,
    `- ran: ${DateTime.formatIso(run.ranAt)}`,
    "",
    prose.trim(),
    ""
  ].join("\n")

/**
 * Whether `head` has the review it needs.
 *
 * A run that reported nothing does not count, which is the same rule
 * `reportedBy` draws everywhere else: a failure has found nothing, not found
 * nothing wrong.
 */
export const reviewedBy = (run: ReviewRun | null): boolean => run !== null && reportedBy(run) !== null

/** The findings at one head that withhold the stamp. */
export const blockingIn = (run: ReviewRun | null, blocksOn: Severity): ReadonlyArray<Finding> => {
  const found = run === null ? null : reportedBy(run)
  return found === null ? [] : blocking(found.findings, blocksOn)
}

/** What the stamp rule reads out of the review runs this machine holds on one head. */
export interface Reviewed {
  /** The head a review run has already covered, or null where none has. */
  readonly reviewRunHead: string | null
  /** Findings on that head that withhold the stamp, at the bar `stamp.blocks_on` sets. */
  readonly blockingFindings: number
}

/**
 * What the review runs on `head` say about it, for the stamp to rest on.
 *
 * Whether a head has been reviewed is the runs' to say and no sweep's: a run is
 * recorded against one head, and a head with no run of its own has not been
 * reviewed however many sweeps have seen the pull request. A run that could not
 * report findings does not count either: its verdict is what takes a pull
 * request out of Needs review run, and it reached none.
 *
 * It is one function because the two callers are a sweep and `dw-mc merge`, and
 * the second exists to land what the first only describes: two spellings of
 * this would be two answers to whether a head has been reviewed.
 */
export const reviewedAt = Effect.fn("review.reviewedAt")(function* (
  repo: string,
  number: number,
  head: string,
  blocksOn: Severity
) {
  const run = Option.getOrNull(yield* runAt(repo, number, head))
  return {
    reviewRunHead: reviewedBy(run) ? head : null,
    blockingFindings: blockingIn(run, blocksOn).length
  } satisfies Reviewed
})
