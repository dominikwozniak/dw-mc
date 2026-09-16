import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"

import type { Pulse } from "#domain/quiet.ts"
import { isQuiet } from "#domain/quiet.ts"

const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso)

const pulse: Pulse = {
  head: "31268022360852f71815404b6bbdd6bd797cfb4c",
  checks: "green",
  newestHumanCommentAt: at("2026-09-15T09:00:00Z")
}

describe("isQuiet", () => {
  it("calls a PR quiet when all three signals are where they were", () => {
    assert.isTrue(isQuiet(pulse, { ...pulse }))
  })

  it("wakes a PR whose head has moved", () => {
    assert.isFalse(isQuiet(pulse, { ...pulse, head: "0000000000000000000000000000000000000000" }))
  })

  it("wakes a PR whose CI has changed its mind", () => {
    assert.isFalse(isQuiet(pulse, { ...pulse, checks: "red" }))
  })

  it("wakes a PR that has been commented on", () => {
    assert.isFalse(isQuiet(pulse, { ...pulse, newestHumanCommentAt: at("2026-09-15T10:00:00Z") }))
  })

  it("wakes a PR that has its first comment", () => {
    assert.isFalse(isQuiet({ ...pulse, newestHumanCommentAt: null }, pulse))
  })

  it("calls a PR nobody has ever commented on quiet", () => {
    const silent: Pulse = { ...pulse, newestHumanCommentAt: null }
    assert.isTrue(isQuiet(silent, { ...silent }))
  })
})
