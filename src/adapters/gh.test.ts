import { assert, describe, it } from "@effect/vitest"
import { Effect, PlatformError } from "effect"

import { currentRepo, requireAuth, viewer } from "#adapters/gh.ts"
import { fakeHandle, layerFake, layerStubbed } from "#adapters/spawner.ts"

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
