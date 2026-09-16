import { Schema } from "effect"

import { isAfter, later } from "#domain/moment.ts"

/** How far GitHub has got towards letting a tracked PR merge. */
export const Mergeability = Schema.Literals(["mergeable", "conflicting", "unknown"])
export type Mergeability = typeof Mergeability.Type

/** What the reviewers have decided, or that nobody is required to. */
export const ReviewDecision = Schema.Literals(["approved", "changes-requested", "review-required", "none"])
export type ReviewDecision = typeof ReviewDecision.Type

/** What CI says about the current head. */
export const ChecksState = Schema.Literals(["green", "red", "pending", "none"])
export type ChecksState = typeof ChecksState.Type

/**
 * Everything the bucket rules are allowed to know about a tracked PR.
 *
 * It is a schema because a sweep writes it to the state directory and reads it
 * back on the next one: the same facts that decide a bucket are what a quiet PR
 * is recognised by.
 */
export const Facts = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  /** Shown, never acted on unless I ask. */
  draft: Schema.Boolean,
  /** The head commit every other fact here is about. */
  head: Schema.String,
  mergeable: Mergeability,
  reviewDecision: ReviewDecision,
  checks: ChecksState,
  /** Why the flaky classifier excuses this red CI, or null where it does not. */
  ciFlaky: Schema.NullOr(Schema.String),
  /** The newest comment from a person who is not me, bots excluded. */
  newestHumanCommentAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  myLastCommentAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  myLastCommitAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** The head a review run has already covered, or null where none has. */
  reviewRunHead: Schema.NullOr(Schema.String),
  /** Findings on this head that withhold the stamp, at the bar `stamp.blocks_on` sets. */
  blockingFindings: Schema.Int
})
export type Facts = typeof Facts.Type

/** The one place a tracked PR sits at a time, named for what it waits on. */
export const Bucket = Schema.Literals(["needs-me", "needs-review-run", "waiting-on-others", "ready"])
export type Bucket = typeof Bucket.Type

/** The bucket a tracked PR is in, and why it is in that one. */
export interface Placement {
  readonly bucket: Bucket
  readonly reason: string
}

/** A tracked PR beside the placement its facts earned. */
export interface Placed {
  readonly facts: Facts
  readonly placement: Placement
}

/** The buckets in the order I act on them: the top of the table is my next move. */
export const order: ReadonlyArray<Bucket> = ["needs-me", "needs-review-run", "waiting-on-others", "ready"]

/**
 * The first of the five rules that makes a PR mine to move, or null when none
 * does. The order is the order I would fix them in: a conflict makes every
 * other signal on the PR stale, and a red build is worth more than a comment.
 */
const needsMe = (facts: Facts): string | null => {
  if (facts.mergeable === "conflicting") {
    return "merge conflict"
  }
  if (facts.checks === "red" && facts.ciFlaky === null) {
    return "CI is red"
  }
  if (facts.reviewDecision === "changes-requested") {
    return "changes requested"
  }
  if (facts.blockingFindings > 0) {
    return `${facts.blockingFindings} blocking finding${facts.blockingFindings === 1 ? "" : "s"}`
  }
  if (isAfter(facts.newestHumanCommentAt, later(facts.myLastCommentAt, facts.myLastCommitAt))) {
    return "a comment I have not answered"
  }
  return null
}

/**
 * What is actually true of a PR nothing is waiting on.
 *
 * Ready is reached by having no reason not to be, so the reason says only what
 * holds: a repository that requires no reviewer produces no approval, and a
 * pull request with no CI at all is not green.
 *
 * A red CI the classifier excused is said out loud, because GitHub does not
 * excuse it: the merge button is mine to press and that check is still red.
 */
const readyReason = (facts: Facts): string => {
  const held = [
    facts.reviewDecision === "approved" ? "approved" : null,
    facts.checks === "green" ? "green" : null,
    facts.mergeable === "mergeable" ? "mergeable" : null
  ].filter((it) => it !== null)
  const standing = held.length === 0 ? "nothing left to wait on" : held.join(", ")
  return facts.checks === "red" && facts.ciFlaky !== null
    ? `${standing} (red CI called flaky: ${facts.ciFlaky})`
    : standing
}

/**
 * The bucket a tracked PR sits in, and the reason for it.
 *
 * This is the single place the bucket rules exist. Every tracked PR lands in
 * exactly one bucket, so the rules are tried in priority order and the first
 * that claims the PR wins: a PR that both needs a review run and has changes
 * requested is mine to move, not the runner's.
 *
 * Ready does not insist on an approval, because a repository that requires no
 * reviewer never produces one. What it insists on is that nobody else has been
 * asked and is yet to answer.
 */
export const place = (facts: Facts): Placement => {
  const mine = needsMe(facts)
  if (mine !== null) {
    return { bucket: "needs-me", reason: mine }
  }
  if (facts.reviewRunHead !== facts.head) {
    return { bucket: "needs-review-run", reason: "no review run on this head" }
  }
  if (facts.reviewDecision === "review-required") {
    return { bucket: "waiting-on-others", reason: "a review from someone else" }
  }
  if (facts.checks === "pending") {
    return { bucket: "waiting-on-others", reason: "CI is still running" }
  }
  return { bucket: "ready", reason: readyReason(facts) }
}

/**
 * The tracked PRs grouped into their buckets, in the order I act on them, with
 * the empty buckets left out so the table is only what there is to do.
 */
/** One bucket with what is in it: a heading in the table, and the rows under it. */
export interface Grouped {
  readonly bucket: Bucket
  readonly placed: ReadonlyArray<Placed>
}

export const group = (facts: ReadonlyArray<Facts>): ReadonlyArray<Grouped> => {
  const placed = facts
    .map((it): Placed => ({ facts: it, placement: place(it) }))
    .toSorted((a, b) => a.facts.repo.localeCompare(b.facts.repo) || a.facts.number - b.facts.number)

  return order
    .map((bucket) => ({ bucket, placed: placed.filter((it) => it.placement.bucket === bucket) }))
    .filter((bucket) => bucket.placed.length > 0)
}
