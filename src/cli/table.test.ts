import { assert, describe, it } from "@effect/vitest"

import { coloured } from "#adapters/paint.ts"
import { table, truncate, visible } from "#cli/table.ts"

describe("how wide a cell is", () => {
  it("counts what a terminal shows, not what the string holds", () => {
    assert.strictEqual(visible(coloured.red("mine")), 4)
    assert.strictEqual(visible(`${coloured.dim("a")}b${coloured.green("c")}`), 3)
  })

  it("counts a link by the text it shows, never by the URL under it", () => {
    assert.strictEqual(visible(coloured.link("dw-mc#28", "https://github.com/dominikwozniak/dw-mc/pull/28")), 8)
  })
})

const url = "https://github.com/dominikwozniak/dw-mc/pull/28"

describe("the table", () => {
  it("lines the columns up", () => {
    assert.deepStrictEqual(
      table(
        [
          ["a", "one"],
          ["bbb", "two"]
        ],
        " │ "
      ),
      ["a   │ one", "bbb │ two"]
    )
  })

  it("lines a coloured column up with a plain one", () => {
    const [first = "", second = ""] = table(
      [
        [coloured.red("a"), "one"],
        ["bbb", "two"]
      ],
      " │ "
    )

    assert.strictEqual(visible(first), visible(second))
    assert.include(first, coloured.red("a"))
  })

  it("lines a linked column up with a plain one, so the URL costs the table nothing", () => {
    const [first = "", second = ""] = table(
      [
        [coloured.link("a", url), "one"],
        ["bbb", "two"]
      ],
      " │ "
    )

    assert.strictEqual(visible(first), visible(second))
    assert.include(first, coloured.link("a", url))
  })

  it("pads outside the colour, so no line ends in blanks a terminal is colouring", () => {
    const [row = ""] = table(
      [
        [coloured.red("a"), "x"],
        ["bbb", "y"]
      ],
      " "
    )

    assert.strictEqual(row, `${coloured.red("a")}   x`)
  })
})

describe("cutting a cell down", () => {
  it("leaves what already fits", () => {
    assert.strictEqual(truncate("short", 10), "short")
  })

  it("marks where it cut", () => {
    assert.strictEqual(truncate("feat: a long subject", 10), "feat: a l…")
  })

  it("keeps a link whole and closed, so nothing after the cut leads anywhere", () => {
    const row = `${coloured.link("dominikwozniak/dw-mc#28", url)} │ feat: a long subject`
    const cut = truncate(row, 30)

    assert.strictEqual(visible(cut), 30)
    assert.include(
      cut,
      coloured.link("dominikwozniak/dw-mc#28", url),
      "the link opens and closes around the reference, so nothing after the cut leads anywhere"
    )
  })

  it("cuts a link's own text down without spilling the sequence", () => {
    const cut = truncate(coloured.link("dominikwozniak/dw-mc#28", url), 10)

    assert.strictEqual(visible(cut), 10)
    assert.isTrue(cut.startsWith(`\x1b]8;;${url}\x1b\\`))
    assert.isTrue(cut.endsWith("\x1b]8;;\x1b\\"))
  })

  it("measures the colour out and keeps it whole", () => {
    const cut = truncate(coloured.red("feat: a long subject"), 10)

    assert.strictEqual(visible(cut), 10)
    assert.isTrue(cut.startsWith("[31m"), "the colour still opens the cell")
    assert.isTrue(cut.endsWith("[0m"), "and still closes it, so nothing after it is red")
  })
})
