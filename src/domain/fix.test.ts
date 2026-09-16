import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import type { Selection } from "#domain/fix.ts"
import { promptFor } from "#domain/fix.ts"

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
      assert.deepStrictEqual(carried(yield* promptFor(selected)), {
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
      const prompt = yield* promptFor(selected)

      assert.include(prompt, "dominikwozniak/dw-mc#28")
      assert.include(prompt, "284d599")
      assert.include(prompt, "Do not commit")
    })
  )
})
