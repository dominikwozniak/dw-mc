import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"

import type { Remark, Thread } from "#adapters/conversation.ts"
import { acknowledging, shown } from "#domain/comments.ts"

const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso)

const mine = at("2026-09-17T12:00:00Z")

const said = (over: Partial<Remark>): Remark => ({
  login: "alice",
  bot: false,
  at: at("2026-09-17T14:00:00Z"),
  body: "the cutoff is the later of the two",
  ...over
})

const thread = (over: Partial<Thread>): Thread => ({
  path: "src/domain/comments.ts",
  line: 42,
  resolved: false,
  outdated: false,
  comments: [said({})],
  ...over
})

describe("shown", () => {
  it("keeps what somebody said after my last activity", () => {
    const fresh = thread({})
    assert.deepStrictEqual(shown([fresh], { since: mine, all: false }), { people: [fresh], bots: [] })
  })

  it("drops what was said before my last activity", () => {
    const old = thread({ comments: [said({ at: at("2026-09-17T09:00:00Z") })] })
    assert.deepStrictEqual(shown([old], { since: mine, all: false }), { people: [], bots: [] })
  })

  it("brings a whole thread along where any of it is newer than my last activity", () => {
    const half = thread({
      comments: [said({ at: at("2026-09-17T09:00:00Z") }), said({ at: at("2026-09-17T15:00:00Z"), body: "still?" })]
    })

    assert.deepStrictEqual(shown([half], { since: mine, all: false }).people, [half])
  })

  it("cuts the pull request's own comments one by one, because they answer nothing", () => {
    const fresh = said({ at: at("2026-09-17T15:00:00Z"), body: "and one more thing" })
    const stream = thread({
      path: null,
      line: null,
      comments: [said({ at: at("2026-09-17T09:00:00Z") }), fresh]
    })

    assert.deepStrictEqual(shown([stream], { since: mine, all: false }).people, [{ ...stream, comments: [fresh] }])
  })

  it("counts everything as newer where I have never said anything", () => {
    const ancient = thread({ comments: [said({ at: at("2020-01-01T00:00:00Z") })] })
    assert.deepStrictEqual(shown([ancient], { since: null, all: false }).people, [ancient])
  })

  it("leaves out a thread somebody resolved", () => {
    assert.deepStrictEqual(shown([thread({ resolved: true })], { since: mine, all: false }), { people: [], bots: [] })
  })

  it("leaves out a thread against code that is gone", () => {
    assert.deepStrictEqual(shown([thread({ outdated: true })], { since: mine, all: false }), { people: [], bots: [] })
  })

  it("keeps a bot's comment apart from a person's", () => {
    const bot = said({ login: "github-actions", bot: true, body: "coverage fell by 0.2%" })
    const mixed = thread({ comments: [said({}), bot] })

    assert.deepStrictEqual(shown([mixed], { since: mine, all: false }), {
      people: [{ ...mixed, comments: [said({})] }],
      bots: [{ ...mixed, comments: [bot] }]
    })
  })

  describe("--all", () => {
    it("shows the resolved, the outdated and the answered alike", () => {
      const resolved = thread({ resolved: true })
      const outdated = thread({ outdated: true, comments: [said({ at: at("2020-01-01T00:00:00Z") })] })

      assert.deepStrictEqual(shown([resolved, outdated], { since: mine, all: true }).people, [resolved, outdated])
    })
  })
})

describe("acknowledging", () => {
  it("covers the newest thing a person said, in any thread, settled or not", () => {
    const threads = [
      thread({ path: null, line: null, comments: [said({ at: at("2026-09-17T14:00:00Z") })] }),
      thread({ resolved: true, comments: [said({ at: at("2026-09-17T16:00:00Z") })] }),
      thread({ outdated: true, comments: [said({ at: at("2026-09-17T15:00:00Z") })] })
    ]
    assert.deepStrictEqual(acknowledging(threads), at("2026-09-17T16:00:00Z"))
  })

  it("leaves a bot out, because the bucket rule never counted one", () => {
    const threads = [
      thread({
        comments: [said({ at: at("2026-09-17T14:00:00Z") }), said({ bot: true, at: at("2026-09-17T18:00:00Z") })]
      })
    ]
    assert.deepStrictEqual(acknowledging(threads), at("2026-09-17T14:00:00Z"))
  })

  it("covers nothing where no person has said anything", () => {
    assert.isNull(acknowledging([thread({ comments: [said({ bot: true })] })]))
    assert.isNull(acknowledging([]))
  })
})
