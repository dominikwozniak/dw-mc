/**
 * The rows of a table, padded so the columns line up and with the trailing
 * blanks cut. Effect ships no table and a table is what these commands print.
 *
 * A cell may arrive with colour on it, and colour is characters a terminal
 * never shows, so every width here is measured in what is shown rather than in
 * what the string holds. Padding is added outside the colour, so no line ends
 * in blanks a terminal is still colouring.
 *
 * `separator` is what sits between two columns. Two spaces are enough where a
 * row is short; a row that runs to a sentence needs a rule, or the eye loses
 * which column it is in.
 */
export const table = (rows: ReadonlyArray<ReadonlyArray<string>>, separator: string = "  "): ReadonlyArray<string> => {
  const widths = rows.reduce<ReadonlyArray<number>>(
    (widest, row) => row.map((cell, index) => Math.max(visible(cell), widest[index] ?? 0)),
    []
  )
  return rows.map((row) =>
    row
      .map((cell, index) => `${cell}${" ".repeat(Math.max((widths[index] ?? 0) - visible(cell), 0))}`)
      .join(separator)
      .trimEnd()
  )
}

// oxlint-disable-next-line no-control-regex -- colour is control characters; matching it is the point
const colour = /(\[\d+m)/
const escape = new RegExp(`^${colour.source}$`)

/** How much of a cell a terminal shows: its characters, less the colour they are wrapped in. */
export const visible = (text: string): number =>
  text.split(colour).reduce((width, piece) => width + (escape.test(piece) ? 0 : piece.length), 0)

/**
 * `text` at most `width` wide, with an ellipsis where it was cut.
 *
 * The width is what is shown, and the colour the cut text was wrapped in is
 * kept whole: a string cut through an escape sequence spills the sequence onto
 * the screen and colours everything after it.
 */
export const truncate = (text: string, width: number): string => {
  if (visible(text) <= width) {
    return text
  }
  let shown = 0
  const kept = text.split(colour).map((piece) => {
    if (escape.test(piece)) {
      return piece
    }
    const taken = piece.slice(0, Math.max(width - 1 - shown, 0))
    shown = shown + taken.length
    return taken
  })
  const last = kept.findLastIndex((piece) => !escape.test(piece) && piece !== "")
  return kept.map((piece, index) => (index === last ? `${piece.trimEnd()}…` : piece)).join("")
}

/** `n` of something, pluralised the one way English usually is. */
export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`
