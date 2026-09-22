import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { prComments } from "#adapters/conversation.ts"
import { layerStubbed, wrote } from "#adapters/spawner.ts"

describe("prComments", () => {
  it.effect("says which comments came from an app rather than a person", () => {
    const answered = layerStubbed({
      stubs: [
        (command) =>
          wrote(
            (command.args[1]?.includes("/issues/") ?? false)
              ? `[{"created_at":"2026-09-15T08:43:44Z","user":{"login":"coderabbitai[bot]","type":"Bot"}}]`
              : `[{"created_at":"2026-09-15T09:00:00Z","user":{"login":"dominikwozniak","type":"User"}}]`
          )
      ]
    })

    return Effect.gen(function* () {
      const comments = yield* prComments("AirHelp/ahplus-rails", 7884)

      assert.deepStrictEqual(
        comments.map((comment) => [comment.login, comment.bot]),
        [
          ["coderabbitai[bot]", true],
          ["dominikwozniak", false]
        ]
      )
    }).pipe(Effect.provide(answered))
  })
})
