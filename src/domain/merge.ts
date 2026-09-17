import type { Facts } from "#domain/bucket.ts"
import type { Stampable } from "#domain/stamp.ts"
import { stampFor, whyNotGreen, whyNotMergeable } from "#domain/stamp.ts"

/** Everything the merge guards are allowed to know about a pull request. */
export interface Situation extends Stampable {
  readonly repo: string
  readonly number: number
  /** Whether I opened it, which is the only kind of pull request this lands. */
  readonly mine: boolean
  readonly draft: boolean
  readonly reviewDecision: Facts["reviewDecision"]
  /** The head I took the stamp off at, or null where I took it off none. */
  readonly withdrawnAt: string | null
}

/**
 * Why GitHub would not call this pull request Ready, or null where it would.
 *
 * Ready is GitHub's opinion and nothing of mine: approved, green, mergeable.
 * A repository that requires no reviewer produces no approval, which is why
 * `none` passes and `review-required` does not - what holds a merge is somebody
 * having been asked and not yet answered.
 *
 * A red CI the flaky classifier excused is still red here. The excuse is a
 * reason not to fix a check; it is not a reason to land code behind one.
 */
const whyNotReady = (situation: Situation): string | null => {
  if (situation.reviewDecision === "changes-requested") {
    return "changes are requested"
  }
  if (situation.reviewDecision === "review-required") {
    return "a review from someone else is still wanted"
  }
  return whyNotGreen[situation.checks] ?? whyNotMergeable[situation.mergeable]
}

/**
 * What to do about a pull request that is Ready and carries no stamp.
 *
 * The stamp is withheld for one of three reasons and each has its own next
 * step, so the refusal names that step rather than leaving me to work out which
 * of the three it was. A withdrawal is the one with no command: I took the mark
 * off code I had read, and only that code changing puts it back.
 */
const earnsIt = (situation: Situation): string => {
  if (situation.withdrawnAt === situation.head) {
    return "\n\nYou took it off at this head, and it stays off until the head changes."
  }
  const next =
    situation.reviewRunHead !== situation.head
      ? {
          command: `dw-mc review ${situation.number}`,
          says: "That reviews this head, and a run that finds nothing blocking stamps it."
        }
      : {
          command: `dw-mc fix ${situation.number}`,
          says:
            "That opens a session on the findings. " +
            "The stamp is back once the head has moved and a review run has read it."
        }
  return `\n\n  ${next.command}\n\n${next.says}`
}

/**
 * Why this pull request is not one to merge, or null where it is.
 *
 * This is the single place the merge guards live, and they carry more than the
 * merge does: it is the one write the tool makes that no reflog of mine undoes
 * (ADR 0008). Two bars have to be clear, because each is blind to what the
 * other sees - GitHub does not know whether anything read the diff, and the
 * stamp does not know whether a reviewer asked for changes.
 *
 * Whose pull request it is comes first, as it does everywhere else: one
 * somebody else opened is none of this tool's business, whatever is true of it.
 * A draft is next, because a pull request I have not offered to anybody is not
 * one to land however green it is.
 *
 * Ready is asked before the stamp so that the refusal names the bar I am
 * actually under. The stamp insists on green CI and a mergeable pull request
 * too, so everything it can be withheld for here is mine rather than GitHub's.
 */
export const decide = (situation: Situation): string | null => {
  const where = `${situation.repo}#${situation.number}`
  if (!situation.mine) {
    return `${where} is not mine. dw-mc merges pull requests I author and nothing else.`
  }
  if (situation.draft) {
    return `${where} is a draft. Mark it ready for review before merging it.`
  }
  const ready = whyNotReady(situation)
  if (ready !== null) {
    return `${where} is not Ready: ${ready}. dw-mc merges nothing GitHub would not merge itself.`
  }

  const stamp = stampFor(situation, situation.withdrawnAt)
  return stamp.stamped ? null : `${where} is Ready and carries no stamp: ${stamp.reason}.${earnsIt(situation)}`
}
