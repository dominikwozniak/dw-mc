/**
 * The rows of a table, padded so the columns line up and with the trailing
 * blanks cut. Effect ships no table and a table is what these commands print.
 *
 * `separator` is what sits between two columns. Two spaces are enough where a
 * row is short; a row that runs to a sentence needs a rule, or the eye loses
 * which column it is in.
 */
export const table = (rows: ReadonlyArray<ReadonlyArray<string>>, separator: string = "  "): ReadonlyArray<string> => {
  const widths = rows.reduce<ReadonlyArray<number>>(
    (widest, row) => row.map((cell, index) => Math.max(cell.length, widest[index] ?? 0)),
    []
  )
  return rows.map((row) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join(separator)
      .trimEnd()
  )
}

/** `text` at most `width` wide, with an ellipsis where it was cut. */
export const truncate = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, width - 1).trimEnd()}…`

/** `n` of something, pluralised the one way English usually is. */
export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`
