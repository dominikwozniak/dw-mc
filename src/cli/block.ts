import { Console, Effect } from "effect"

import type { Paint } from "#adapters/paint.ts"
import { count } from "#cli/table.ts"
import { short } from "#domain/review.ts"

/**
 * How a command that reports rather than tabulates writes its page: in blocks,
 * each a heading with its body indented under it, and a blank line before the
 * next one (ADR 0007).
 *
 * What a command says is its own. The shape is here, so a report reads the
 * same whichever command wrote it, and so do the three lines more than one of
 * them writes: the opener, the files a rebase stopped on, and a command to
 * retype.
 *
 * A block is its lines, and a line of prose on its own is a block with no
 * body. Nothing here colours a heading or a line of prose.
 */

/**
 * A line of a block's body, under its heading. A blank line stays blank.
 *
 * On its own it is for a body written a line at a time, under a heading
 * already on the screen, while the command is still finding out what it says.
 */
export const indent = (line: string): string => (line === "" ? "" : `  ${line}`)

/** One block: the heading, then the body indented under it. */
export const block = (heading: string, body: ReadonlyArray<string>): ReadonlyArray<string> => [
  heading,
  ...body.map(indent)
]

const nonEmpty = (lines: ReadonlyArray<string>): boolean => lines.length > 0

/**
 * The blocks of one page, a blank line apart. A block that came to nothing
 * leaves no gap where it would have been.
 */
export const separated = (blocks: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> =>
  blocks.filter(nonEmpty).flatMap((lines, index) => (index === 0 ? lines : ["", ...lines]))

/**
 * Blocks that follow what is already on the screen - a line written before a
 * session, a prompt or a heartbeat took the terminal - so each of them opens
 * on its blank line, the first as well.
 */
export const following = (blocks: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> =>
  blocks.filter(nonEmpty).flatMap((lines) => ["", ...lines])

/** A page's lines, printed one to a line. */
export const print = (lines: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.forEach(lines, (line) => Console.log(line), { discard: true })

/** A head that moved, said as where it was and where it is now. */
export interface Moved {
  readonly before: string
  readonly after: string
}

/**
 * The line a report on one pull request opens on: which one, at which head,
 * and what happened to it. The head is context, so it is dim.
 */
export const opener = (paint: Paint, repo: string, number: number, head: string | Moved, what: string): string =>
  `${repo}#${number}  ${
    typeof head === "string"
      ? paint.dim(short(head))
      : `${paint.dim(short(head.before))} → ${paint.dim(short(head.after))}`
  }  ${what}`

/** The files a rebase stopped on, under their count, or nothing where none is known. */
export const stoppedOn = (paint: Paint, paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.length === 0 ? [] : block(`It stopped on ${count(paths.length, "file")}:`, paths.map(paint.dim))

/**
 * Commands I am meant to retype, one to a line, as a block of their own so
 * they stand clear of the prose around them. Cyan is the one colour no state
 * uses, so it says this and nothing else.
 */
export const retype = (paint: Paint, ...commands: ReadonlyArray<string>): ReadonlyArray<string> =>
  commands.map((command) => indent(paint.cyan(command)))
