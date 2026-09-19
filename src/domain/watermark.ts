import { DateTime, Effect, Option, Schema } from "effect"

import { prKey, remembered, storeFor } from "#adapters/store.ts"
import type { Placed } from "#domain/bucket.ts"
import { Bucket } from "#domain/bucket.ts"
import { isAfter } from "#domain/moment.ts"
import { ChecksState, Mergeability, ReviewDecision } from "#terms/pr.ts"

/** What a row turns on, which is what a watermark keeps of it. */
const Said = Schema.Struct({
  bucket: Bucket,
  mergeable: Mergeability,
  checks: ChecksState,
  /** Whether the flaky classifier excused a red CI. */
  excused: Schema.Boolean,
  reviewDecision: ReviewDecision,
  blockingFindings: Schema.Int,
  newestHumanCommentAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  draft: Schema.Boolean
})
type Said = typeof Said.Type

/**
 * The moment a tracked PR's row was last shown to me, and what the row said.
 *
 * It is kept on its own rather than on `Facts`, because a quiet PR carries its
 * old facts forward unchanged and a moment stored there would be about the
 * wrong thing. What it holds is only what a row turns on, so a fact the sweep
 * starts reading later does not make every row look new.
 *
 * Only a command that puts the row on screen writes one. A sweep on its own
 * shows nothing, and moving the watermark there would erase movement nobody saw.
 */
export const Watermark = Schema.Struct({ at: Schema.DateTimeUtcFromString, ...Said.fields })
export type Watermark = typeof Watermark.Type

/**
 * What happened to a row since it was last shown.
 *
 * A row never shown is its own case rather than one that moved: "it moved" and
 * "I have never seen it" are different messages. `from` is the bucket it left,
 * and is there only where it left one.
 */
export type Since =
  | { readonly _tag: "new" }
  | { readonly _tag: "still" }
  | { readonly _tag: "moved"; readonly from: Bucket | undefined; readonly what: ReadonlyArray<string> }

const keyOf = ({ facts }: Placed): string => prKey(facts.repo, facts.number)

/** What a row says. */
const said = ({ facts, placement }: Placed): Said => ({
  bucket: placement.bucket,
  mergeable: facts.mergeable,
  checks: facts.checks,
  excused: facts.ciFlaky !== null,
  reviewDecision: facts.reviewDecision,
  blockingFindings: facts.blockingFindings,
  newestHumanCommentAt: facts.newestHumanCommentAt,
  draft: facts.draft
})

/** What a row said at the moment it was shown. */
export const sighted = (placed: Placed, at: DateTime.Utc): Watermark => ({ at, ...said(placed) })

const ci = (it: Said): string => (it.checks === "red" && it.excused ? "red, called flaky" : it.checks)

const review: Record<ReviewDecision, string> = {
  approved: "approved",
  "changes-requested": "changes requested",
  "review-required": "review required",
  none: "no review decision"
}

const draftMoved = (then: Said, now: Said): string | null => {
  if (then.draft === now.draft) {
    return null
  }
  return now.draft ? "back to draft" : "out of draft"
}

/**
 * The facts that moved between two sightings, said the way the row would say them.
 *
 * The head is left out on purpose: it changes on every push, and a list that
 * leads with it drowns what the push did. A mergeability GitHub has not worked
 * out yet is left out too, because it flickers to unknown and back on its own.
 */
const moved = (then: Said, now: Said): ReadonlyArray<string> =>
  [
    then.mergeable !== now.mergeable && then.mergeable !== "unknown" && now.mergeable !== "unknown"
      ? `${then.mergeable} → ${now.mergeable}`
      : null,
    ci(then) !== ci(now) ? `CI ${ci(then)} → ${ci(now)}` : null,
    then.reviewDecision !== now.reviewDecision
      ? `${review[then.reviewDecision]} → ${review[now.reviewDecision]}`
      : null,
    then.blockingFindings !== now.blockingFindings
      ? `${then.blockingFindings} → ${now.blockingFindings} blocking findings`
      : null,
    isAfter(now.newestHumanCommentAt, then.newestHumanCommentAt) ? "a new comment" : null,
    draftMoved(then, now)
  ].filter((it) => it !== null)

/**
 * What happened to a row since `watermark`, the last time it was shown.
 *
 * Movement is a bucket transition plus the facts that moved with it. Either one
 * alone misses something: every field compared drowns in the head, and a bucket
 * on its own says nothing when CI goes green on a PR still mine for another
 * reason.
 */
export const since = (watermark: Watermark | undefined, placed: Placed): Since => {
  if (watermark === undefined) {
    return { _tag: "new" }
  }
  const now = said(placed)
  const what = moved(watermark, now)
  const from = watermark.bucket === now.bucket ? undefined : watermark.bucket
  return from === undefined && what.length === 0 ? { _tag: "still" } : { _tag: "moved", from, what }
}

/**
 * What happened to each of these rows since it was last shown.
 *
 * It answers for any row, and a row it was not given is one it has no
 * watermark for, which is a row never shown.
 */
export const sinceShown = Effect.fn("watermark.sinceShown")(function* (placed: ReadonlyArray<Placed>) {
  const store = yield* storeFor("watermarks", Watermark)
  const found = new Map(
    yield* Effect.forEach(placed, (it) => {
      const key = keyOf(it)
      return Effect.map(remembered(store.get(key)), (mark) => [key, since(Option.getOrUndefined(mark), it)] as const)
    })
  )
  return (it: Placed): Since => found.get(keyOf(it)) ?? { _tag: "new" }
})

/** Records that these rows were shown to me, now, saying what they say. */
export const markShown = Effect.fn("watermark.markShown")(function* (placed: ReadonlyArray<Placed>) {
  const store = yield* storeFor("watermarks", Watermark)
  const now = yield* DateTime.now
  yield* Effect.forEach(placed, (it) => store.set(keyOf(it), sighted(it, now)), { discard: true })
})
