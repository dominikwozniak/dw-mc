import type { Paint } from "#adapters/paint.ts"
import { truncate } from "#cli/table.ts"
import type { Bucket, Placed } from "#domain/bucket.ts"

/**
 * How one tracked PR is written down, wherever it is written down.
 *
 * The table `dw-mc status` prints and the list the picker asks me to choose
 * from are the same rows, so a pull request reads the same in both and neither
 * command owns how the other draws it.
 *
 * Colour here says one thing: which bucket the pull request is in, and so what
 * it waits on. Everything else on the row is either `dim`, because it is
 * context rather than state, or left alone. A row read with no colour at all
 * says the same, which is what the marker is for.
 *
 * On a table, the pull request opens itself: the reference carries the URL for
 * the terminal to follow, and nothing else on the row does. What it leads to is
 * where the row already says it is, so a row read where no link can be followed
 * - a pipe, a paste, a terminal that ignores the sequence - loses nothing.
 */

/** The glossary's name for each bucket, which is what the heading says. */
export const heading: Record<Bucket, string> = {
  "needs-me": "Needs me",
  "needs-review-run": "Needs review run",
  "waiting-on-others": "Waiting on others",
  ready: "Ready"
}

/**
 * The mark that says which bucket a row is in without being read.
 *
 * One character apiece, from the part of Unicode a terminal font has: the
 * padding is counted in characters, and a glyph a terminal draws double width
 * takes a column the count never gave it. How full the mark looks tracks how
 * much of the pull request is done, so the column reads at a glance even where
 * the colour is off.
 */
export const marker: Record<Bucket, string> = {
  "needs-me": "●",
  "needs-review-run": "◐",
  "waiting-on-others": "○",
  ready: "◆"
}

/** The colour a bucket is said in: red is mine, yellow is next, green is done, dim is not my turn. */
export const tint = (paint: Paint, bucket: Bucket): ((text: string) => string) =>
  ({
    "needs-me": paint.red,
    "needs-review-run": paint.yellow,
    "waiting-on-others": paint.dim,
    ready: paint.green
  })[bucket]

/** Long enough for a conventional-commit subject, short enough to keep a row on one line. */
export const titleWidth = 56

/** What sits between two columns: three columns of prose run into one another without a rule. */
export const rule = " │ "

/**
 * How the bucket is said on a row: glued to the pull request, or a column of
 * its own that names it too.
 *
 * A table has a heading over each bucket, so the mark alone is all a row there
 * needs. A prompt has no headings to group under, so the bucket is named on
 * every row of it.
 */
export type Lead = "marker" | "named"

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
 *
 * A named lead carries the colour for the whole row. It is the one place a
 * prompt's row is coloured, and it carries no link at all: a prompt counts the
 * lines it has to erase from the length of what it drew, escape sequences and
 * all, so every colour on a row costs the title characters it could have shown,
 * and a link costs it the whole URL. The table has no such arithmetic to keep
 * straight, so its rows say it in more than one place and open the pull request
 * besides.
 */
export const cells = (
  placed: Placed,
  stamped: boolean,
  room: number,
  paint: Paint,
  lead: Lead
): ReadonlyArray<string> => {
  const { facts } = placed
  const { bucket } = placed.placement
  const say = tint(paint, bucket)
  const reference = `${facts.repo}#${facts.number}`
  const named = lead === "named"
  const pr = `${named ? reference : paint.link(reference, facts.url)}${
    facts.draft ? paint.dim(" (draft)") : ""
  }${stamped ? ` ${paint.green("✓")}` : ""}`

  return named
    ? [say(`${marker[bucket]} ${heading[bucket]}`), pr, truncate(facts.title, room), placed.placement.reason]
    : [`${say(marker[bucket])} ${pr}`, paint.dim(truncate(facts.title, room)), say(placed.placement.reason)]
}
