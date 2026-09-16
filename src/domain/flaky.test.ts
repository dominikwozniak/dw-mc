import { assert, describe, it } from "@effect/vitest"

import type { Evidence } from "#domain/flaky.ts"
import { classify } from "#domain/flaky.ts"

/** A red CI with none of the three signals firing. */
const unexplained: Evidence = {
  alsoRedOnDefaultBranch: [],
  changedFiles: ["src/domain/flaky.ts"],
  log: "Error: expected 3 to be 4\n"
}

const evidence = (over: Partial<Evidence>): Evidence => ({ ...unexplained, ...over })

describe("classify", () => {
  describe("one signal at a time", () => {
    it("calls a failure nothing explains mine to fix", () => {
      assert.deepStrictEqual(classify(unexplained, []), {
        classification: "legitimate",
        reason: "nothing explains the failure",
        signals: { redOnDefaultBranch: null, namesChangedFile: null, flakyPattern: null }
      })
    })

    it("calls a failure the default branch has too flaky", () => {
      const verdict = classify(evidence({ alsoRedOnDefaultBranch: ["Quality gate"] }), [])

      assert.strictEqual(verdict.classification, "flaky")
      assert.strictEqual(verdict.reason, "Quality gate is red on the default branch too")
      assert.strictEqual(verdict.signals.redOnDefaultBranch, "Quality gate")
    })

    it("calls a failure that matches a known flaky pattern flaky", () => {
      const verdict = classify(evidence({ log: "dial tcp: ECONNRESET\n" }), [])

      assert.strictEqual(verdict.classification, "flaky")
      assert.strictEqual(verdict.reason, 'the log matches "ECONNRESET"')
      assert.strictEqual(verdict.signals.flakyPattern, "ECONNRESET")
    })

    it("matches a known flaky pattern whatever case the log prints it in", () => {
      assert.strictEqual(classify(evidence({ log: "Timed Out waiting for the runner" }), []).classification, "flaky")
    })

    it("calls a failure whose log names a file this PR changes mine to fix", () => {
      const verdict = classify(evidence({ log: "FAIL src/domain/flaky.ts:12:3\n" }), [])

      assert.strictEqual(verdict.classification, "legitimate")
      assert.strictEqual(verdict.reason, "the log names src/domain/flaky.ts, which this PR changes")
      assert.strictEqual(verdict.signals.namesChangedFile, "src/domain/flaky.ts")
    })

    it("names a changed file the log prints without its directory", () => {
      const verdict = classify(evidence({ log: "  at flaky.ts:12:3\n" }), [])

      assert.strictEqual(verdict.classification, "legitimate")
      assert.strictEqual(verdict.signals.namesChangedFile, "src/domain/flaky.ts")
    })

    it("prefers the file the log spells in full over one it matches by name alone", () => {
      const verdict = classify(
        evidence({
          changedFiles: ["src/cli/table.ts", "src/domain/flaky.ts"],
          log: "  at table.ts:1:1\nFAIL src/domain/flaky.ts:12:3\n"
        }),
        []
      )

      assert.strictEqual(verdict.signals.namesChangedFile, "src/domain/flaky.ts")
    })
  })

  describe("signals together", () => {
    it("reports both flaky signals when both fire", () => {
      const verdict = classify(
        evidence({ alsoRedOnDefaultBranch: ["Quality gate"], log: "Error: context deadline exceeded" }),
        []
      )

      assert.strictEqual(verdict.classification, "flaky")
      assert.strictEqual(
        verdict.reason,
        'Quality gate is red on the default branch too, and the log matches "deadline exceeded"'
      )
    })

    it("hands a failure back to me when the log names a file I changed, whatever else fired", () => {
      const verdict = classify(
        evidence({ alsoRedOnDefaultBranch: ["Quality gate"], log: "ETIMEDOUT in src/domain/flaky.ts" }),
        []
      )

      assert.strictEqual(verdict.classification, "legitimate")
      assert.strictEqual(verdict.reason, "the log names src/domain/flaky.ts, which this PR changes")
    })

    it("records every signal it saw, even the ones the verdict did not turn on", () => {
      const verdict = classify(
        evidence({ alsoRedOnDefaultBranch: ["Quality gate"], log: "ETIMEDOUT in src/domain/flaky.ts" }),
        []
      )

      assert.deepStrictEqual(verdict.signals, {
        redOnDefaultBranch: "Quality gate",
        namesChangedFile: "src/domain/flaky.ts",
        flakyPattern: "ETIMEDOUT"
      })
    })
  })

  describe("the patterns I added myself", () => {
    it("honours a pattern from the configuration", () => {
      const verdict = classify(evidence({ log: "Error: Chromium revision is not downloaded" }), [
        "Chromium revision is not downloaded"
      ])

      assert.strictEqual(verdict.classification, "flaky")
      assert.strictEqual(verdict.signals.flakyPattern, "Chromium revision is not downloaded")
    })

    it("reports mine before the built-in one when both match", () => {
      const verdict = classify(evidence({ log: "ETIMEDOUT while pulling the image" }), ["while pulling the image"])

      assert.strictEqual(verdict.signals.flakyPattern, "while pulling the image")
    })

    it("takes a pattern as text and not as a regular expression", () => {
      assert.strictEqual(classify(evidence({ log: "an unrelated failure" }), [".*"]).classification, "legitimate")
    })
  })

  it("is a function of its arguments and nothing else", () => {
    const twice = [classify(unexplained, []), classify(unexplained, [])]

    assert.deepStrictEqual(twice[0], twice[1])
  })
})
