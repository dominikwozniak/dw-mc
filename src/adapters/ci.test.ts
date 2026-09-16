import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { defaultBranch, failedChecks, jobIdOf, jobLog, prFiles, rollupState, workflowFailsOn } from "#adapters/ci.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"

/** A spawner that answers every program the same way, and records the argv. */
const answering = (spawned: Array<ReadonlyArray<string>>, handle: Parameters<typeof fakeHandle>[0]) =>
  layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("ci.test: the fake was handed a piped command")
    }
    spawned.push([command.command, ...command.args])
    return Effect.succeed(fakeHandle(handle))
  })

describe("rollupState", () => {
  const run = (name: string, conclusion: string, status = "COMPLETED") => ({ name, status, conclusion })

  it("calls a PR with nothing to run neither green nor red", () => {
    assert.strictEqual(rollupState([], []), "none")
    assert.strictEqual(rollupState(null, []), "none")
  })

  it("calls a rollup green when every check that counts has passed", () => {
    assert.strictEqual(rollupState([run("Check", "SUCCESS"), run("Lint", "SKIPPED")], []), "green")
  })

  it("calls a rollup red the moment one check has failed", () => {
    assert.strictEqual(rollupState([run("Check", "SUCCESS"), run("Lint", "FAILURE")], []), "red")
  })

  it("prefers red over pending, because a failure is already mine to fix", () => {
    assert.strictEqual(rollupState([run("Check", "", "IN_PROGRESS"), run("Lint", "FAILURE")], []), "red")
  })

  it("calls a rollup pending while a check is still running", () => {
    assert.strictEqual(rollupState([run("Check", "SUCCESS"), run("Lint", "", "IN_PROGRESS")], []), "pending")
  })

  it("reads a commit status, which reports a state rather than a conclusion", () => {
    assert.strictEqual(rollupState([{ context: "ci/circleci", state: "FAILURE" }], []), "red")
    assert.strictEqual(rollupState([{ context: "ci/circleci", state: "PENDING" }], []), "pending")
    assert.strictEqual(rollupState([{ context: "ci/circleci", state: "SUCCESS" }], []), "green")
  })

  it("lets a check I have decided to live with out of the count", () => {
    assert.strictEqual(rollupState([run("Check", "SUCCESS"), run("codecov", "FAILURE")], ["codecov"]), "green")
  })

  it("calls a rollup of nothing but ignored checks neither green nor red", () => {
    assert.strictEqual(rollupState([run("codecov", "FAILURE")], ["codecov"]), "none")
  })
})

describe("what the classifier reads", () => {
  const run = (name: string, conclusion: string, status = "COMPLETED") => ({ name, status, conclusion })

  it("picks out the checks that failed and count", () => {
    assert.deepStrictEqual(
      failedChecks([run("Check", "SUCCESS"), run("Lint", "FAILURE"), run("codecov", "FAILURE")], ["codecov"]),
      [run("Lint", "FAILURE")]
    )
  })

  it("finds nothing to classify in a rollup that is not there", () => {
    assert.deepStrictEqual(failedChecks(null, []), [])
  })

  it("reads the job a check run reports at out of its URL", () => {
    assert.strictEqual(
      jobIdOf("https://github.com/dominikwozniak/dw-mc/actions/runs/35089608203/job/104772538303"),
      "104772538303"
    )
  })

  it("has no job for a commit status, which reports somewhere else", () => {
    assert.strictEqual(jobIdOf("https://circleci.com/gh/dominikwozniak/dw-mc/1"), null)
    assert.strictEqual(jobIdOf(undefined), null)
  })

  it.effect("asks gh which branch a repository merges into", () => {
    const spawned: Array<ReadonlyArray<string>> = []
    const gh = answering(spawned, { stdout: `{"defaultBranchRef":{"name":"main"}}` })

    return Effect.gen(function* () {
      assert.strictEqual(yield* defaultBranch("dominikwozniak/dw-mc"), "main")
      assert.deepStrictEqual(spawned, [["gh", "repo", "view", "dominikwozniak/dw-mc", "--json", "defaultBranchRef"]])
    }).pipe(Effect.provide(gh))
  })

  it.effect("guesses main for a repository that has no branches yet", () => {
    const gh = answering([], { stdout: `{"defaultBranchRef":null}` })

    return Effect.gen(function* () {
      assert.strictEqual(yield* defaultBranch("dominikwozniak/empty"), "main")
    }).pipe(Effect.provide(gh))
  })

  it.effect("calls a workflow whose newest run on the branch failed red there too", () => {
    const spawned: Array<ReadonlyArray<string>> = []
    const gh = answering(spawned, { stdout: `[{"conclusion":"failure"},{"conclusion":"success"}]` })

    return Effect.gen(function* () {
      assert.isTrue(yield* workflowFailsOn("dominikwozniak/dw-mc", "main", "Quality gate"))
      assert.deepStrictEqual(spawned, [
        [
          "gh",
          "run",
          "list",
          "--repo",
          "dominikwozniak/dw-mc",
          "--branch",
          "main",
          "--workflow",
          "Quality gate",
          "--limit",
          "5",
          "--json",
          "conclusion"
        ]
      ])
    }).pipe(Effect.provide(gh))
  })

  it.effect("does not call a workflow red on the branch for a failure that has since been fixed", () => {
    const gh = answering([], { stdout: `[{"conclusion":"success"},{"conclusion":"failure"}]` })

    return Effect.gen(function* () {
      assert.isFalse(yield* workflowFailsOn("dominikwozniak/dw-mc", "main", "Quality gate"))
    }).pipe(Effect.provide(gh))
  })

  it.effect("looks past a skipped or cancelled run, which decided nothing either way", () => {
    const gh = answering([], {
      stdout: `[{"conclusion":"skipped"},{"conclusion":"cancelled"},{"conclusion":"failure"}]`
    })

    return Effect.gen(function* () {
      assert.isTrue(yield* workflowFailsOn("dominikwozniak/dw-mc", "main", "Quality gate"))
    }).pipe(Effect.provide(gh))
  })

  it.effect("calls a workflow that has never reached a verdict on the branch not red", () => {
    const gh = answering([], { stdout: `[{"conclusion":"skipped"}]` })

    return Effect.gen(function* () {
      assert.isFalse(yield* workflowFailsOn("dominikwozniak/dw-mc", "main", "Quality gate"))
    }).pipe(Effect.provide(gh))
  })

  it.effect("asks gh which files a pull request changes", () => {
    const spawned: Array<ReadonlyArray<string>> = []
    const gh = answering(spawned, { stdout: `{"files":[{"path":"src/cli/sweep.ts","additions":1,"deletions":0}]}` })

    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* prFiles("dominikwozniak/dw-mc", 25), ["src/cli/sweep.ts"])
      assert.deepStrictEqual(spawned, [["gh", "pr", "view", "25", "--repo", "dominikwozniak/dw-mc", "--json", "files"]])
    }).pipe(Effect.provide(gh))
  })

  it.effect("asks for a failing job's log with the escape sequences a runner writes", () => {
    const spawned: Array<ReadonlyArray<string>> = []
    const gh = answering(spawned, { stdout: "2026-09-16T11:18:35Z Current runner version: '2.337.0'" })

    return Effect.gen(function* () {
      assert.include(yield* jobLog("dominikwozniak/dw-mc", "104772538303"), "runner version")
      assert.deepStrictEqual(spawned, [
        ["gh", "api", "repos/dominikwozniak/dw-mc/actions/jobs/104772538303/logs", "--allow-escape-sequences"]
      ])
    }).pipe(Effect.provide(gh))
  })

  it.effect("keeps the end of a log too long to hold, which is where a failure prints", () => {
    const gh = answering([], { stdout: `${"noise\n".repeat(20_000)}Error: expected 3 to be 4` })

    return Effect.gen(function* () {
      const log = yield* jobLog("dominikwozniak/dw-mc", "1")

      assert.strictEqual(log.length, 64 * 1024)
      assert.isTrue(log.endsWith("Error: expected 3 to be 4"))
    }).pipe(Effect.provide(gh))
  })
})
