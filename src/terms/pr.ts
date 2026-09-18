/**
 * What GitHub says about a pull request, in this tool's words.
 *
 * The three of them are here because both sides need the same one: `gh` and the
 * checks adapter answer in these words, and the bucket rules decide on them. A
 * union restated on each side is a case that goes unreachable the day the other
 * side gains a member.
 */
import { Schema } from "effect"

/** How far GitHub has got towards letting a tracked PR merge. */
export const Mergeability = Schema.Literals(["mergeable", "conflicting", "unknown"])
export type Mergeability = typeof Mergeability.Type

/** What the reviewers have decided, or that nobody is required to. */
export const ReviewDecision = Schema.Literals(["approved", "changes-requested", "review-required", "none"])
export type ReviewDecision = typeof ReviewDecision.Type

/** What CI says about the current head. */
export const ChecksState = Schema.Literals(["green", "red", "pending", "none"])
export type ChecksState = typeof ChecksState.Type
