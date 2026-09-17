import { assert, describe, it } from "@effect/vitest"

import { coloured } from "#adapters/paint.ts"
import { table, truncate, visible } from "#cli/table.ts"

describe("how wide a cell is", () => {
  it("counts what a terminal shows, not what the string holds", () => {
    assert.strictEqual(visible(coloured.red("mine")), 4)
    assert.strictEqual(visible(`${coloured.dim("a")}b${coloured.green("c")}`), 3)
  })
})

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

  it("measures the colour out and keeps it whole", () => {
    const cut = truncate(coloured.red("feat: a long subject"), 10)

    assert.strictEqual(visible(cut), 10)
    assert.isTrue(cut.startsWith("[31m"), "the colour still opens the cell")
    assert.isTrue(cut.endsWith("[0m"), "and still closes it, so nothing after it is red")
  })
})
