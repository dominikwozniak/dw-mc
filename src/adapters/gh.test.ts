import { assert, describe, it } from "@effect/vitest"
import { Effect, PlatformError } from "effect"

import {
  comparedFiles,
  currentRepo,
  mergeabilityOf,
  prComments,
  requireAuth,
  reviewDecisionOf,
  viewer
} from "#adapters/gh.ts"
import { fakeHandle, layerFake, layerStubbed, wrote } from "#adapters/spawner.ts"

/** A spawner that answers every program the same way, and records the argv. */
const answering = (spawned: Array<ReadonlyArray<string>>, handle: Parameters<typeof fakeHandle>[0]) =>
  layerStubbed({
    onSpawn: (command) => spawned.push([command.command, ...command.args]),
    stubs: [() => Effect.succeed(fakeHandle(handle))]
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

describe("comparedFiles", () => {
  const base = "284d599022a55d4dcae74b31b9a49a0f50061014"
  const head = "9c1f0b7a1d1e4a2c8b3f5d6e7a8b9c0d1e2f3a4b"

  it.effect("asks GitHub what changed between two commits", () => {
    const spawned: Array<ReadonlyArray<string>> = []
    const compared = answering(spawned, {
      stdout: JSON.stringify({ files: [{ filename: "README.md" }, { filename: "src/cli/review.ts" }] })
    })

    return Effect.gen(function* () {
      const files = yield* comparedFiles("dominikwozniak/dw-mc", base, head)

      assert.deepStrictEqual(files, ["README.md", "src/cli/review.ts"])
      assert.deepStrictEqual(spawned, [["gh", "api", `repos/dominikwozniak/dw-mc/compare/${base}...${head}`]])
    }).pipe(Effect.provide(compared))
  })

  it.effect("reads a comparison with nothing between its two commits", () => {
    const empty = answering([], { stdout: JSON.stringify({ status: "identical" }) })

    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* comparedFiles("dominikwozniak/dw-mc", base, base), [])
    }).pipe(Effect.provide(empty))
  })

  it.effect("says what it could not read rather than reporting no change", () => {
    const gone = answering([], { exitCode: 1, stderr: "gh: No commit found for SHA\n" })

    return Effect.gen(function* () {
      const error = yield* Effect.flip(comparedFiles("dominikwozniak/dw-mc", base, head))

      assert.strictEqual(error._tag, "GhReadFailed")
      assert.include(error.message, "No commit found")
    }).pipe(Effect.provide(gone))
  })
})
