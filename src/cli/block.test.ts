import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { coloured, plain } from "#adapters/paint.ts"
import { recording } from "#adapters/picker.ts"
import { block, following, opener, print, retype, separated, stoppedOn } from "#cli/block.ts"

const head = "284d599022a55d4dcae74b31b9a49a0f50061014"
const after = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"

describe("a block", () => {
  it("is its heading with the body indented under it", () => {
    assert.deepStrictEqual(block("Stays", ["repos/a.git", "repos/b.git"]), ["Stays", "  repos/a.git", "  repos/b.git"])
  })

  it("keeps a body's own indentation under its own", () => {
    assert.deepStrictEqual(block("a.ts:3", ["@alice", "  the text"]), ["a.ts:3", "  @alice", "    the text"])
  })

  it("leaves a blank line in the body blank, with no indent hanging off it", () => {
    assert.deepStrictEqual(block("a.ts:3", ["one", "", "two"]), ["a.ts:3", "  one", "", "  two"])
  })

  it("is only its heading where there is no body", () => {
    assert.deepStrictEqual(block("clean, nothing to fix", []), ["clean, nothing to fix"])
  })
})

describe("blocks on one page", () => {
  it("stand a blank line apart, with none before the first or after the last", () => {
    assert.deepStrictEqual(separated([block("Takes back", ["a"]), ["prose"], block("Stays", ["b"])]), [
      "Takes back",
      "  a",
      "",
      "prose",
      "",
      "Stays",
      "  b"
    ])
  })

  it("leave no gap where a block came to nothing", () => {
    assert.deepStrictEqual(separated([[], ["one"], [], ["two"], []]), ["one", "", "two"])
    assert.deepStrictEqual(separated([[], []]), [])
  })

  it("that follow something already on the screen open on a blank line of their own", () => {
    assert.deepStrictEqual(following([["one"], [], ["two"]]), ["", "one", "", "two"])
    assert.deepStrictEqual(following([[]]), [])
  })

  it.effect("are printed a line at a time", () =>
    Effect.gen(function* () {
      const printed: Array<string> = []
      yield* print(separated([["one"], ["two"]])).pipe(recording(printed))
      assert.deepStrictEqual(printed, ["one", "", "two"])
    })
  )
})

describe("the opener", () => {
  it("names the pull request, the head it is about and what happened to it", () => {
    assert.strictEqual(
      opener(plain, "dominikwozniak/dw-mc", 28, head, "already on main"),
      "dominikwozniak/dw-mc#28  284d599  already on main"
    )
  })

  it("names both heads where the head moved", () => {
    assert.strictEqual(
      opener(plain, "dominikwozniak/dw-mc", 28, { before: head, after }, "rebased"),
      "dominikwozniak/dw-mc#28  284d599 → 9f2b0c1  rebased"
    )
  })

  it("dims the head, which is context, and leaves the reference and what happened plain", () => {
    assert.strictEqual(
      opener(coloured, "dominikwozniak/dw-mc", 28, head, "stamped"),
      `dominikwozniak/dw-mc#28  ${coloured.dim("284d599")}  stamped`
    )
  })
})

describe("the files a rebase stopped on", () => {
  it("are counted over the paths, indented under the count", () => {
    assert.deepStrictEqual(stoppedOn(plain, ["a.ts", "b.ts"]), ["It stopped on 2 files:", "  a.ts", "  b.ts"])
  })

  it("dim every path, which is context", () => {
    assert.deepStrictEqual(stoppedOn(coloured, ["a.ts"]), ["It stopped on 1 file:", `  ${coloured.dim("a.ts")}`])
  })

  it("come to nothing where no file is known", () => {
    assert.deepStrictEqual(stoppedOn(plain, []), [])
  })
})

describe("a command to retype", () => {
  it("is indented, one to a line", () => {
    assert.deepStrictEqual(retype(plain, "cd /tmp/w", "git push"), ["  cd /tmp/w", "  git push"])
  })

  it("is cyan, the one colour no state uses", () => {
    assert.deepStrictEqual(retype(coloured, "git push"), [`  ${coloured.cyan("git push")}`])
  })

  it("stands a blank line clear of the prose on both sides", () => {
    assert.deepStrictEqual(separated([["It stopped."], retype(plain, "dw-mc resolve 28"), ["That opens a session."]]), [
      "It stopped.",
      "",
      "  dw-mc resolve 28",
      "",
      "That opens a session."
    ])
  })
})
