/**
 * The columns of a table, padded to line up and with the trailing blanks cut.
 *
 * Effect ships no table, and a table is all these commands print, so this is it:
 * it takes the cells and gives back the lines.
 */
export const table = (rows: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> => {
  const widths = rows.reduce<ReadonlyArray<number>>(
    (widest, row) => row.map((cell, index) => Math.max(cell.length, widest[index] ?? 0)),
    []
  )
  return rows.map((row) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd()
  )
}

/** `text` at most `width` wide, with an ellipsis where it was cut. */
export const truncate = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, width - 1).trimEnd()}…`
