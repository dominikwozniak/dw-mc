import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"

import { isAfter, isSame, later, newest } from "#domain/moment.ts"

const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso)

const early = at("2026-09-15T08:00:00Z")
const late = at("2026-09-15T09:00:00Z")

describe("isAfter", () => {
  it("compares two moments", () => {
    assert.isTrue(isAfter(late, early))
    assert.isFalse(isAfter(early, late))
    assert.isFalse(isAfter(early, early))
  })

  it("counts never as before anything", () => {
    assert.isTrue(isAfter(early, null))
    assert.isFalse(isAfter(null, early))
    assert.isFalse(isAfter(null, null))
  })
})

describe("later", () => {
  it("takes the later of the two, whichever way round they come", () => {
    assert.strictEqual(later(early, late), late)
    assert.strictEqual(later(late, early), late)
    assert.strictEqual(later(null, early), early)
    assert.strictEqual(later(null, null), null)
  })
})

describe("isSame", () => {
  it("compares the moment and not the object", () => {
    assert.isTrue(isSame(early, at("2026-09-15T08:00:00Z")))
    assert.isFalse(isSame(early, late))
  })

  it("counts never as the same as never, and as nothing else", () => {
    assert.isTrue(isSame(null, null))
    assert.isFalse(isSame(null, early))
    assert.isFalse(isSame(early, null))
  })
})

describe("newest", () => {
  it("takes the latest of many", () => {
    assert.strictEqual(newest([early, late, early]), late)
  })

  it("has no moment to give when there are none", () => {
    assert.strictEqual(newest([]), null)
  })
})
