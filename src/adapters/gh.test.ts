import { assert, describe, it } from "@effect/vitest"
import { Effect, PlatformError } from "effect"

import {
  currentRepo,
  defaultBranch,
  failedChecks,
  jobIdOf,
  jobLog,
  mergeabilityOf,
  prComments,
  prFiles,
  requireAuth,
  reviewDecisionOf,
  rollupState,
  viewer,
  workflowFailsOn
} from "#adapters/gh.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"

/** A spawner that answers every program the same way, and records the argv. */
const answering = (spawned: Array<ReadonlyArray<string>>, handle: Parameters<typeof fakeHandle>[0]) =>
  layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("gh.test: the fake was handed a piped command")
    }
    spawned.push([command.command, ...command.args])
    return Effect.succeed(fakeHandle(handle))
  })

describe("requireAuth", () => {
  it.effect("asks gh whether it is logged in", () => {
    const spawned: Array<ReadonlyArray<string>> = []
    const loggedIn = answering(spawned, {
      stdout: "github.com\n  ✓ Logged in to github.com account dominikwozniak (keyring)\n"
    })

    return Effect.gen(function* () {
      yield* requireAuth

      assert.deepStrictEqual(spawned, [["gh", "auth", "status"]])
    }).pipe(Effect.provide(loggedIn))
  })

  it.effect("stops with somewhere to install gh when gh is not there", () => {
    const missing = layerFake(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "spawn gh ENOENT"
        })
      )
    )

    return Effect.gen(function* () {
      const error = yield* Effect.flip(requireAuth)

      assert.strictEqual(error._tag, "GhUnavailable")
      assert.include(error.message, "https://cli.github.com")
      assert.include(error.message, "not installed")
    }).pipe(Effect.provide(missing))
  })

  it.effect("stops with what to run when gh is there but logged out", () => {
    const loggedOut = answering([], {
      exitCode: 1,
      stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n"
    })

    return Effect.gen(function* () {
      const error = yield* Effect.flip(requireAuth)

      assert.strictEqual(error._tag, "GhUnauthenticated")
      assert.include(error.message, "gh auth login")
      assert.include(error.message, "You are not logged into any GitHub hosts")
    }).pipe(Effect.provide(loggedOut))
  })
})

describe("currentRepo", () => {
  it.effect("takes owner/repo from gh, so I never type it", () => {
    const spawned: Array<ReadonlyArray<string>> = []
    const inRepo = answering(spawned, { stdout: `{"nameWithOwner":"dominikwozniak/dw-mc"}` })

    return Effect.gen(function* () {
      assert.strictEqual(yield* currentRepo, "dominikwozniak/dw-mc")
      assert.deepStrictEqual(spawned, [["gh", "repo", "view", "--json", "nameWithOwner"]])
    }).pipe(Effect.provide(inRepo))
  })

  it.effect("reports that there is no repository here, with what gh said", () => {
    const outside = answering([], {
      exitCode: 1,
      stderr: "failed to run git: fatal: not a git repository (or any of the parent directories): .git\n"
    })

    return Effect.gen(function* () {
      const error = yield* Effect.flip(currentRepo)

      assert.strictEqual(error._tag, "NoRepository")
      assert.include(error.message, "not a git repository")
    }).pipe(Effect.provide(outside))
  })

  it.effect("refuses to guess when gh answers with something else", () => {
    const changed = answering([], { stdout: `{"name":"dw-mc"}` })

    return Effect.gen(function* () {
      const error = yield* Effect.flip(currentRepo)

      assert.strictEqual(error._tag, "GhUnreadable")
      assert.include(error.message, "gh repo view")
    }).pipe(Effect.provide(changed))
  })
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

describe("gh's words in ours", () => {
  it("reads what gh says about merging", () => {
    assert.strictEqual(mergeabilityOf("MERGEABLE"), "mergeable")
    assert.strictEqual(mergeabilityOf("CONFLICTING"), "conflicting")
    assert.strictEqual(mergeabilityOf("UNKNOWN"), "unknown")
  })

  it("reads an empty review decision as nobody having been asked", () => {
    assert.strictEqual(reviewDecisionOf(""), "none")
    assert.strictEqual(reviewDecisionOf("APPROVED"), "approved")
    assert.strictEqual(reviewDecisionOf("CHANGES_REQUESTED"), "changes-requested")
    assert.strictEqual(reviewDecisionOf("REVIEW_REQUIRED"), "review-required")
  })
})

describe("viewer", () => {
  it.effect("asks gh who it is logged in as", () => {
    const spawned: Array<ReadonlyArray<string>> = []
    const loggedIn = answering(spawned, { stdout: `{"login":"dominikwozniak","id":47635604}` })

    return Effect.gen(function* () {
      assert.strictEqual(yield* viewer, "dominikwozniak")
      assert.deepStrictEqual(spawned, [["gh", "api", "user"]])
    }).pipe(Effect.provide(loggedIn))
  })
})

describe("prComments", () => {
  it.effect("says which comments came from an app rather than a person", () => {
    const answered = layerFake((command) => {
      if (command._tag !== "StandardCommand") {
        return Effect.die("gh.test: the fake was handed a piped command")
      }
      const body =
        (command.args[1]?.includes("/issues/") ?? false)
          ? `[{"created_at":"2026-09-15T08:43:44Z","user":{"login":"coderabbitai[bot]","type":"Bot"}}]`
          : `[{"created_at":"2026-09-15T09:00:00Z","user":{"login":"dominikwozniak","type":"User"}}]`
      return Effect.succeed(fakeHandle({ stdout: body }))
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

  it.effect("calls a workflow with a recent failure on the branch red there too", () => {
    const spawned: Array<ReadonlyArray<string>> = []
    const gh = answering(spawned, { stdout: `[{"conclusion":"success"},{"conclusion":"failure"}]` })

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

  it.effect("does not call a workflow red on the branch for being skipped or cancelled there", () => {
    const gh = answering([], { stdout: `[{"conclusion":"skipped"},{"conclusion":"cancelled"}]` })

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
