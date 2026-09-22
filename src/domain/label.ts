import type { Settings } from "#adapters/config.ts"
import type { Facts } from "#domain/bucket.ts"

/** What the review label of a pull request is decided on: its head, and what the run on that head found. */
export type Labelled = Pick<Facts, "head" | "reviewRunHead" | "blockingFindings">

/**
 * The review label the pull request has earned at its head, or none.
 *
 * It follows the stamp's review half and nothing else: a run that reported on
 * this head, judged at `stamp.blocks_on`. A head nothing has reviewed carries
 * no verdict, so a push takes the label with it rather than leaving the last
 * head's word on code nobody read.
 */
export const reviewLabelOf = (pr: Labelled, labels: Settings["labels"]): string | null => {
  if (!labels.enabled || pr.reviewRunHead !== pr.head) {
    return null
  }
  return pr.blockingFindings > 0 ? labels.changes : labels.approved
}

/** What bringing a pull request's labels in line takes: at most one to add, and the tool's own others to remove. */
export interface Relabel {
  readonly add: string | null
  readonly remove: ReadonlyArray<string>
}

/**
 * The writes that leave `onPr` carrying the review label `pr` has earned.
 *
 * Only the two names the repository configured are the tool's own. Every other
 * label on the pull request is somebody's, and a repository that does not label
 * has every label left alone, the tool's own included.
 */
export const relabel = (pr: Labelled, labels: Settings["labels"], onPr: ReadonlyArray<string>): Relabel => {
  if (!labels.enabled) {
    return { add: null, remove: [] }
  }
  const earned = reviewLabelOf(pr, labels)
  const own = [labels.approved, labels.changes]
  return {
    add: earned === null || onPr.includes(earned) ? null : earned,
    remove: onPr.filter((name) => own.includes(name) && name !== earned)
  }
}
