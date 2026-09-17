import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { blocking, jsonSchema, Reported } from "#domain/findings.ts"
import type { Severity } from "#terms/review.ts"

const read = Schema.decodeUnknownEffect(Reported)

const one = (severity: string) => ({
  verdict: "findings",
  findings: [{ file: "src/cli/review.ts", line: 88, severity, summary: "The findings turn is never recorded." }]
})

const severityIn = (output: unknown) => Effect.map(read(output), (found) => found.findings[0]?.severity)

describe("the findings a review run reports", () => {
  it.effect("reads what a runner answered, finding by finding", () =>
    Effect.gen(function* () {
      const reported = yield* read({
        verdict: "findings",
        findings: [
          { file: "src/cli/review.ts", line: 88, severity: "error", summary: "The findings turn is never recorded." },
          { file: "docs/v1-design.md", line: 3, severity: "info", summary: "The build order is out of date." }
        ]
      })

      assert.deepStrictEqual(reported, {
        verdict: "findings",
        findings: [
          { file: "src/cli/review.ts", line: 88, severity: "error", summary: "The findings turn is never recorded." },
          { file: "docs/v1-design.md", line: 3, severity: "info", summary: "The build order is out of date." }
        ]
      })
    })
  )

  it.effect("reads a clean verdict with nothing under it", () =>
    Effect.gen(function* () {
      const reported = yield* read({ verdict: "clean", findings: [] })

      assert.deepStrictEqual(reported, { verdict: "clean", findings: [] })
    })
  )

  it.effect("weighs a persona's own severities in ours", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* severityIn(one("Critical")), "error")
      assert.strictEqual(yield* severityIn(one("Required")), "error")
      assert.strictEqual(yield* severityIn(one("Optional")), "warning")
      assert.strictEqual(yield* severityIn(one("Nit")), "info")
      assert.strictEqual(yield* severityIn(one("FYI")), "info")
    })
  )

  it.effect("keeps the three severities of its own", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* severityIn(one("error")), "error")
      assert.strictEqual(yield* severityIn(one("warning")), "warning")
      assert.strictEqual(yield* severityIn(one("info")), "info")
    })
  )

  it.effect("refuses a severity nothing weighs, rather than guessing at it", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(read(one("blocker")))

      assert.include(error.message, `["findings"][0]["severity"]`)
    })
  )

  it.effect("refuses a finding that says nothing about where it is", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        read({ verdict: "findings", findings: [{ file: "src/cli/review.ts", severity: "error", summary: "..." }] })
      )

      assert.include(error.message, "line")
    })
  )

  it.effect("refuses a verdict that is neither clean nor findings", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(read({ verdict: "failed", findings: [] }))

      assert.include(error.message, "verdict")
    })
  )

  it("asks the runner for exactly what it will be held to", () => {
    const schema: unknown = JSON.parse(jsonSchema)
    // The document is what `claude --json-schema` is handed, so it is read here
    // the way the runner reads it rather than through the schema it came from.
    assert.deepStrictEqual(schema, {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["clean", "findings"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              line: { type: "integer" },
              summary: { type: "string" },
              severity: { type: "string", enum: ["error", "warning", "info"] }
            },
            required: ["file", "line", "summary", "severity"],
            additionalProperties: true
          }
        }
      },
      required: ["verdict", "findings"],
      additionalProperties: true
    })
  })

  describe("the findings that withhold the stamp", () => {
    const findings = [
      { file: "a.ts", line: 1, severity: "error", summary: "one" },
      { file: "b.ts", line: 2, severity: "warning", summary: "two" },
      { file: "c.ts", line: 3, severity: "info", summary: "three" },
      { file: "d.ts", line: 4, severity: "error", summary: "four" }
    ] as const

    const filesOf = (blocksOn: Severity) => blocking(findings, blocksOn).map((finding) => finding.file)

    it("counts an error and nothing else, which is the bar I keep", () => {
      assert.deepStrictEqual(filesOf("error"), ["a.ts", "d.ts"])
    })

    it("counts a warning as well where the bar says warnings block", () => {
      assert.deepStrictEqual(filesOf("warning"), ["a.ts", "b.ts", "d.ts"])
    })

    it("counts every finding where the bar is as tight as it goes", () => {
      assert.deepStrictEqual(filesOf("info"), ["a.ts", "b.ts", "c.ts", "d.ts"])
    })
  })
})
