import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import type { Selection } from "#domain/fix.ts"
import { promptFor, staleAt } from "#domain/fix.ts"

const selected: Selection = {
  repo: "dominikwozniak/dw-mc",
  number: 28,
  head: "284d599022a55d4dcae74b31b9a49a0f50061014",
  findings: [
    {
      file: "src/cli/review.ts",
      line: 88,
      severity: "error",
      summary: "The run is never recorded.",
      note: "Record it against the head the worktree stands on."
    },
    { file: "src/adapters/git.ts", line: 12, severity: "warning", summary: "The worktree outlives the run." }
  ]
}

/** The JSON object the prompt carries, back as an object a test can read. */
const carried = (prompt: string): unknown => {
  const json = prompt.slice(prompt.indexOf("{"))
  return JSON.parse(json)
}

describe("promptFor", () => {
  it.effect("carries the selected findings as the JSON the schema defines", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(carried(yield* promptFor(selected, false)), {
        repo: "dominikwozniak/dw-mc",
        number: 28,
        head: "284d599022a55d4dcae74b31b9a49a0f50061014",
        findings: [
          {
            file: "src/cli/review.ts",
            line: 88,
            summary: "The run is never recorded.",
            severity: "error",
            note: "Record it against the head the worktree stands on."
          },
          {
            file: "src/adapters/git.ts",
            line: 12,
            summary: "The worktree outlives the run.",
            severity: "warning"
          }
        ]
      })
    })
  )

  it.effect("says whose findings they are and that committing is mine", () =>
    Effect.gen(function* () {
      const prompt = yield* promptFor(selected, false)

      assert.include(prompt, "dominikwozniak/dw-mc#28")
      assert.include(prompt, "284d599")
      assert.include(prompt, "Do not commit")
    })
  )
})

describe("staleAt", () => {
  it("has nothing to say where the findings and the pull request are at one head", () => {
    assert.isNull(staleAt(28, selected.head, selected.head))
  })

  it("names both heads and the run that would make them one again", () => {
    const said = staleAt(28, selected.head, "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192")

    assert.include(said, "284d599")
    assert.include(said, "9f2b0c1")
    assert.include(said, "dw-mc review 28")
  })
})

describe("what the session may do in the worktree", () => {
  it.effect("keeps committing mine where the repository says so", () =>
    Effect.gen(function* () {
      const prompt = yield* promptFor(selected, false)

      assert.include(prompt, "Do not commit and do not push")
    })
  )

  it.effect("lets the session commit where I asked for it, and pushing stays mine", () =>
    Effect.gen(function* () {
      const prompt = yield* promptFor(selected, true)

      assert.include(prompt, "Commit what you change")
      assert.include(prompt, "Do not push")
    })
  )
})
