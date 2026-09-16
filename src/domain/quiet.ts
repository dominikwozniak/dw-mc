import { DateTime } from "effect"

import type { ChecksState, Facts } from "#domain/bucket.ts"

/**
 * The three signals that say whether a tracked PR has moved at all.
 *
 * They are the cheap facts: a sweep can read them without paging through a PR's
 * history, which is the whole point of comparing them.
 */
export interface Pulse {
  readonly head: string
  readonly checks: ChecksState
  readonly newestHumanCommentAt: DateTime.Utc | null
}

/** The pulse of a PR a previous sweep recorded. */
export const pulseOf = (facts: Facts): Pulse => ({
  head: facts.head,
  checks: facts.checks,
  newestHumanCommentAt: facts.newestHumanCommentAt
})

const sameMoment = (self: DateTime.Utc | null, other: DateTime.Utc | null): boolean =>
  self === null || other === null ? self === other : DateTime.toEpochMillis(self) === DateTime.toEpochMillis(other)

/**
 * Whether a PR is where the last sweep left it.
 *
 * A quiet PR keeps the facts it already had rather than being read out again,
 * so a sweep over many pull requests spends its time on the few that moved.
 */
export const isQuiet = (previous: Pulse, current: Pulse): boolean =>
  previous.head === current.head &&
  previous.checks === current.checks &&
  sameMoment(previous.newestHumanCommentAt, current.newestHumanCommentAt)
