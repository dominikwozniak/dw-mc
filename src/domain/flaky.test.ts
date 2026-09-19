import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { layerStubbed, refused, wrote } from "#adapters/spawner.ts"
import type { Evidence } from "#domain/flaky.ts"
import { classify, evidenceFor } from "#domain/flaky.ts"

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
        reason: "nothing explains the failure"
      })
    })

    it("calls a failure the default branch has too flaky", () => {
      const verdict = classify(evidence({ alsoRedOnDefaultBranch: ["Quality gate"] }), [])

      assert.strictEqual(verdict.classification, "flaky")
      assert.strictEqual(verdict.reason, "Quality gate is red on the default branch too")
    })

    it("calls a failure that matches a known flaky pattern flaky", () => {
      const verdict = classify(evidence({ log: "dial tcp: ECONNRESET\n" }), [])

      assert.strictEqual(verdict.classification, "flaky")
      assert.strictEqual(verdict.reason, 'the log matches "ECONNRESET"')
    })

    it("matches a known flaky pattern whatever case the log prints it in", () => {
      assert.strictEqual(classify(evidence({ log: "Timed Out waiting for the runner" }), []).classification, "flaky")
    })

    it("calls a failure whose log names a file this PR changes mine to fix", () => {
      const verdict = classify(evidence({ log: "FAIL src/domain/flaky.ts:12:3\n" }), [])

      assert.strictEqual(verdict.classification, "legitimate")
      assert.strictEqual(verdict.reason, "the log names src/domain/flaky.ts, which this PR changes")
    })

    it("names a changed file the log prints without its directory", () => {
      const verdict = classify(evidence({ log: "  at flaky.ts:12:3\n" }), [])

      assert.strictEqual(verdict.classification, "legitimate")
      assert.strictEqual(verdict.reason, "the log names src/domain/flaky.ts, which this PR changes")
    })

    it("does not take a longer name ending in a changed file's name for that file", () => {
      const verdict = classify(evidence({ changedFiles: ["src/a.ts"], log: "FAIL test/data.ts:1:1" }), [])

      assert.strictEqual(verdict.reason, "nothing explains the failure")
    })

    it("prefers the file the log spells in full over one it matches by name alone", () => {
      const verdict = classify(
        evidence({
          changedFiles: ["src/cli/table.ts", "src/domain/flaky.ts"],
          log: "  at table.ts:1:1\nFAIL src/domain/flaky.ts:12:3\n"
        }),
        []
      )

      assert.strictEqual(verdict.reason, "the log names src/domain/flaky.ts, which this PR changes")
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

    it("hands a failure back to me when the default branch is red and the log names a file I changed", () => {
      const verdict = classify(
        evidence({ alsoRedOnDefaultBranch: ["Quality gate"], log: "FAIL src/domain/flaky.ts:12:3" }),
        []
      )

      assert.strictEqual(verdict.classification, "legitimate")
      assert.strictEqual(verdict.reason, "the log names src/domain/flaky.ts, which this PR changes")
    })

    it("hands a failure back to me when a flaky pattern matches and the log names a file I changed", () => {
      const verdict = classify(evidence({ log: "ETIMEDOUT reaching src/domain/flaky.ts" }), [])

      assert.strictEqual(verdict.classification, "legitimate")
      assert.strictEqual(verdict.reason, "the log names src/domain/flaky.ts, which this PR changes")
    })
  })

  describe("the patterns I added myself", () => {
    it("honours a pattern from the configuration", () => {
      const verdict = classify(evidence({ log: "Error: Chromium revision is not downloaded" }), [
        "Chromium revision is not downloaded"
      ])

      assert.strictEqual(verdict.classification, "flaky")
      assert.strictEqual(verdict.reason, 'the log matches "Chromium revision is not downloaded"')
    })

    it("reports mine before the built-in one when both match", () => {
      const verdict = classify(evidence({ log: "ETIMEDOUT while pulling the image" }), ["while pulling the image"])

      assert.strictEqual(verdict.reason, 'the log matches "while pulling the image"')
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

describe("evidenceFor", () => {
  const repo = "dominikwozniak/dw-mc"

  const failed = (workflow = "Quality gate", job = "104772538303") => ({
    name: "Check",
    status: "COMPLETED",
    conclusion: "FAILURE",
    workflowName: workflow,
    detailsUrl: `https://github.com/${repo}/actions/runs/1/job/${job}`
  })

  /** A `gh` that answers each read from `answers`, and refuses anything in `refuses`. */
  const gh = (options: {
    readonly answers: Record<string, string>
    readonly refuses?: ReadonlyArray<string> | undefined
    readonly spawned?: Array<string> | undefined
  }) =>
    layerStubbed({
      onSpawn: (command) => options.spawned?.push(command.args.join(" ")),
      stubs: [
        (_, argv) =>
          (options.refuses?.some((pattern) => argv.includes(pattern)) ?? false)
            ? refused("gh: Not Found (HTTP 404)")
            : undefined,
        (_, argv) => {
          const key = Object.keys(options.answers).find((read) => argv.includes(read))
          return key === undefined ? undefined : wrote(options.answers[key] ?? "")
        }
      ]
    })

  const answers = {
    "--json defaultBranchRef": `{"defaultBranchRef":{"name":"main"}}`,
    "run list": `[{"conclusion":"failure"}]`,
    "--json files": `{"files":[{"path":"src/cli/sweep.ts"}]}`,
    "/logs": "connect ETIMEDOUT"
  }

  it.effect("reads all three signals off the failing checks", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* evidenceFor(repo, 25, [failed()], []), {
        alsoRedOnDefaultBranch: ["Quality gate"],
        changedFiles: ["src/cli/sweep.ts"],
        log: "connect ETIMEDOUT"
      })
      assert.isTrue(spawned.some((argv) => argv.includes("--branch main --workflow Quality gate")))
    }).pipe(Effect.provide(gh({ answers, spawned })))
  })

  it.effect("asks about a workflow once however many of its jobs failed", () => {
    const spawned: Array<string> = []
    const checks = [failed("Quality gate", "1"), failed("Quality gate", "2")]

    return Effect.gen(function* () {
      yield* evidenceFor(repo, 25, checks, [])

      assert.strictEqual(spawned.filter((argv) => argv.startsWith("run list")).length, 1)
      assert.strictEqual(spawned.filter((argv) => argv.includes("/logs")).length, 2)
    }).pipe(Effect.provide(gh({ answers, spawned })))
  })

  it.effect("reads at most three logs, however many jobs failed", () => {
    const spawned: Array<string> = []
    const checks = [1, 2, 3, 4, 5].map((job) => failed("Quality gate", String(job)))

    return Effect.gen(function* () {
      yield* evidenceFor(repo, 25, checks, [])

      assert.strictEqual(spawned.filter((argv) => argv.includes("/logs")).length, 3)
    }).pipe(Effect.provide(gh({ answers, spawned })))
  })

  it.effect("keeps the signals it can read when a log has aged out of GitHub", () =>
    Effect.gen(function* () {
      const read = yield* evidenceFor(repo, 25, [failed()], [])

      assert.strictEqual(read.log, "")
      assert.deepStrictEqual(read.alsoRedOnDefaultBranch, ["Quality gate"])
      assert.deepStrictEqual(read.changedFiles, ["src/cli/sweep.ts"])
    }).pipe(Effect.provide(gh({ answers, refuses: ["/logs"] })))
  )

  it.effect("keeps the signals it can read when the changed files will not come back", () =>
    Effect.gen(function* () {
      const read = yield* evidenceFor(repo, 25, [failed()], [])

      assert.deepStrictEqual(read.changedFiles, [])
      assert.strictEqual(read.log, "connect ETIMEDOUT")
    }).pipe(Effect.provide(gh({ answers, refuses: ["--json files"] })))
  )

  it.effect("comes back with nothing, and so with legitimate, when gh will not say which branch", () =>
    Effect.gen(function* () {
      const read = yield* evidenceFor(repo, 25, [failed()], [])

      assert.deepStrictEqual(read, { alsoRedOnDefaultBranch: [], changedFiles: [], log: "" })
      assert.strictEqual(classify(read, []).classification, "legitimate")
    }).pipe(Effect.provide(gh({ answers, refuses: ["--json defaultBranchRef"] })))
  )

  it.effect("reads nothing at all for a check ci.ignore says does not count", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      const read = yield* evidenceFor(repo, 25, [failed()], ["Check"])

      assert.strictEqual(read.log, "")
      assert.deepStrictEqual(read.alsoRedOnDefaultBranch, [])
      assert.isFalse(spawned.some((argv) => argv.includes("/logs") || argv.startsWith("run list")))
    }).pipe(Effect.provide(gh({ answers, spawned })))
  })
})
