import { truncate } from "#cli/table.ts"
import type { Bucket, Placed } from "#domain/bucket.ts"

/**
 * How one tracked PR is written down, wherever it is written down.
 *
 * The table `dw-mc status` prints and the list the picker asks me to choose
 * from are the same rows, so a pull request reads the same in both and neither
 * command owns how the other draws it.
 */

/** The glossary's name for each bucket, which is what the heading says. */
export const heading: Record<Bucket, string> = {
  "needs-me": "Needs me",
  "needs-review-run": "Needs review run",
  "waiting-on-others": "Waiting on others",
  ready: "Ready"
}

/** Long enough for a conventional-commit subject, short enough to keep a row on one line. */
export const titleWidth = 56

/** What sits between two columns: three columns of prose run into one another without a rule. */
export const rule = " │ "

/**
 * One row: which pull request, what it is, and what it waits on.
 *
 * A stamp is a mark beside the pull request rather than a column of its own, so
 * a table where nothing is stamped is exactly the table it was before: the
 * stamp is a thing I look for, not a thing I read every row of.
 *
 * The title is the only cell with give in it, so how much room it gets is the
 * caller's to say: a table printed down the screen can afford a whole commit
 * subject, and a row inside a prompt has a column more to carry and a frame
 * around it.
 */
export const cells = (placed: Placed, stamped: boolean, room: number): ReadonlyArray<string> => [
  `${placed.facts.repo}#${placed.facts.number}${placed.facts.draft ? " (draft)" : ""}${stamped ? " ✓" : ""}`,
  truncate(placed.facts.title, room),
  placed.placement.reason
]
