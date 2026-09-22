import { assert, describe, it } from "@effect/vitest"

import type { Settings } from "#adapters/config.ts"
import type { Labelled } from "#domain/label.ts"
import { relabel, reviewLabelOf } from "#domain/label.ts"

const head = "31268022360852f71815404b6bbdd6bd797cfb4c"
const other = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"

const labels: Settings["labels"] = { enabled: true, approved: "review: approved", changes: "review: changes" }

const clean: Labelled = { head, reviewRunHead: head, blockingFindings: 0 }

describe("reviewLabelOf", () => {
  it("is the approved label where the run on this head blocks nothing", () => {
    assert.strictEqual(reviewLabelOf(clean, labels), "review: approved")
  })

  it("is the changes label where the run on this head has a blocking finding", () => {
    assert.strictEqual(reviewLabelOf({ ...clean, blockingFindings: 2 }, labels), "review: changes")
  })

  it("is none where the run covered another head", () => {
    assert.strictEqual(reviewLabelOf({ ...clean, reviewRunHead: other }, labels), null)
  })

  it("is none where no run reported on this head", () => {
    assert.strictEqual(reviewLabelOf({ ...clean, reviewRunHead: null }, labels), null)
  })

  it("is none where the repository does not label", () => {
    assert.strictEqual(reviewLabelOf(clean, { ...labels, enabled: false }), null)
  })
})

describe("relabel", () => {
  it("adds the label a reviewed head has earned", () => {
    assert.deepStrictEqual(relabel(clean, labels, ["bug"]), { add: "review: approved", remove: [] })
  })

  it("asks for nothing where the pull request already carries it", () => {
    assert.deepStrictEqual(relabel(clean, labels, ["review: approved"]), { add: null, remove: [] })
  })

  it("swaps one verdict for the other", () => {
    assert.deepStrictEqual(relabel({ ...clean, blockingFindings: 1 }, labels, ["review: approved"]), {
      add: "review: changes",
      remove: ["review: approved"]
    })
  })

  it("takes both off a head nothing has reviewed yet", () => {
    assert.deepStrictEqual(
      relabel({ ...clean, reviewRunHead: null }, labels, ["review: approved", "review: changes"]),
      {
        add: null,
        remove: ["review: approved", "review: changes"]
      }
    )
  })

  it("leaves every label that is not its own", () => {
    assert.deepStrictEqual(relabel({ ...clean, reviewRunHead: null }, labels, ["bug", "review"]), {
      add: null,
      remove: []
    })
  })

  it("touches nothing where the repository does not label", () => {
    assert.deepStrictEqual(relabel(clean, { ...labels, enabled: false }, ["review: changes"]), {
      add: null,
      remove: []
    })
  })
})
