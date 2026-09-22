import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"

import type { ConfigFile } from "#adapters/config.ts"
import { write } from "#adapters/config.ts"
import { recording } from "#adapters/picker.ts"
import { prViewOf } from "#adapters/pr.ts"
import { json, layerStubbed, refused, vectorOf, wrote } from "#adapters/spawner.ts"
import * as Store from "#adapters/store.ts"
import { machineOf, run } from "#cli/cli.ts"
import { Conflict, conflictFor } from "#domain/rebase.ts"

const repo = "dominikwozniak/dw-mc"
const branch = "feat/28-a-branch"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"
const rebased = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"

const state = "/home/dw/.local/state/dw-mc"
const clone = `${state}/repos/${repo}.git`
const worktree = `${state}/worktrees/${repo}/28`

/** One entry of a status check rollup, as `gh` answers with it. */
const check = (conclusion: string | null) => ({
  name: "build",
  status: conclusion === null ? "IN_PROGRESS" : "COMPLETED",
  ...(conclusion === null ? {} : { conclusion })
})

/** Every program the command spawns, from fixtures, and a death for anything else. */
const machine = (options: {
  readonly spawned: Array<string>
  /** What CI says about the head, where the pull request has CI at all. */
  readonly checks?: ReadonlyArray<ReturnType<typeof check>> | undefined
  /** How many commits the base has that the head does not. */
  readonly behind?: number | undefined
  /** The branch the pull request merges into. */
  readonly base?: string | undefined
  /** Every open pull request on the repository, by branch. */
  readonly open?: ReadonlyArray<{ number: number; headRefName: string; baseRefName: string }> | undefined
  /** Whether replaying the commits onto the base conflicts. */
  readonly conflicts?: boolean | undefined
  /** The files a conflicted replay leaves unmerged in the worktree. */
  readonly unmerged?: ReadonlyArray<string> | undefined
  /** Who opened the pull request, where it was not me. */
  readonly author?: string | undefined
  /** Whether the head branch lives in a fork. */
  readonly fromFork?: boolean | undefined
}) => {
  const base = options.base ?? "main"
  return machineOf({
    spawner: layerStubbed({
      onSpawn: (command) => options.spawned.push(vectorOf(command)),
      stubs: [
        (command, argv) => {
          if (command.command !== "git") {
            return undefined
          }
          if (argv === `-C ${clone} rev-parse --is-bare-repository`) {
            return wrote("true\n")
          }
          if (argv === `-C ${clone} rev-parse refs/dw-mc/pr/28`) {
            return wrote(`${head}\n`)
          }
          if (argv === `-C ${worktree} rev-list --count HEAD..refs/heads/${base}`) {
            return wrote(`${options.behind ?? 0}\n`)
          }
          if (argv === `-C ${worktree} rebase refs/heads/${base}` && options.conflicts === true) {
            return refused("CONFLICT (content): Merge conflict in a.ts\n")
          }
          if (argv === `-C ${worktree} rev-parse HEAD`) {
            return wrote(`${rebased}\n`)
          }
          if (argv === `-C ${worktree} diff --name-only --diff-filter=U`) {
            // A content conflict always leaves the file unmerged, which is what
            // tells it from a replay that stopped for any other reason.
            const unmerged = options.unmerged ?? (options.conflicts === true ? ["a.ts"] : [])
            return wrote(unmerged.map((path) => `${path}\n`).join(""))
          }
          return wrote("")
        },
        (_, argv) =>
          /^pr view 28 --repo \S+ --json \S+$/.test(argv)
            ? json(
                prViewOf(repo, {
                  number: 28,
                  title: "feat: rebase one branch",
                  headRefOid: head,
                  headRefName: branch,
                  baseRefName: base,
                  author: options.author,
                  isCrossRepository: options.fromFork,
                  statusCheckRollup: options.checks ?? []
                })
              )
            : undefined,
        (_, argv) => (argv === "api user" ? json({ login: "dominikwozniak" }) : undefined),
        (_, argv) =>
          /^pr list --repo \S+ --state open/.test(argv)
            ? json(options.open ?? [{ number: 28, headRefName: branch, baseRefName: base }])
            : undefined
      ]
    })
  })
}

/** A repository that has turned rebase on, which is off until it does. */
const enabled = write({ repos: { [repo]: { rebase: { enabled: true } } } } satisfies ConfigFile)
const registered = write({ repos: { [repo]: {} } } satisfies ConfigFile)

const pushes = (spawned: ReadonlyArray<string>) => spawned.filter((vector) => vector.includes(" push "))

describe("dw-mc rebase", () => {
  it.effect("rebases a branch that is behind its base and pushes it with a lease", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* enabled

      yield* run("rebase", "28")

      assert.include(printed.join("\n"), "284d599 → 9f2b0c1")
      assert.include(printed.join("\n"), "rebased 3 commits of main and pushed with a lease")
      assert.deepStrictEqual(pushes(spawned), [
        `git -C ${worktree} push --force-with-lease=refs/heads/${branch}:${head} origin HEAD:refs/heads/${branch}`
      ])
    }).pipe(Effect.provide(machine({ spawned, behind: 3, checks: [check("SUCCESS")] })), recording(printed))
  })

  it.effect("rebases a branch with no CI at all", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* enabled

      yield* run("rebase", "28")

      assert.strictEqual(pushes(spawned).length, 1)
    }).pipe(Effect.provide(machine({ spawned, behind: 2 })), recording(printed))
  })

  it.effect("leaves a branch that is already on its base alone", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* enabled

      yield* run("rebase", "28")

      assert.deepStrictEqual(printed, [`${repo}#28  284d599  already on main`])
      assert.deepStrictEqual(pushes(spawned), [])
    }).pipe(Effect.provide(machine({ spawned, behind: 0, checks: [check("SUCCESS")] })), recording(printed))
  })

  it.effect("puts a conflict in Needs me, pushes nothing, and leaves no half-finished rebase", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* enabled

      yield* run("rebase", "28")

      assert.include(printed.join("\n"), "conflicted")
      assert.include(printed.join("\n"), "Needs me")
      assert.deepStrictEqual(pushes(spawned), [])
      assert.include(spawned, `git -C ${worktree} rebase --abort`)
      assert.strictEqual(spawned.at(-1), `git -C ${clone} worktree remove --force ${worktree}`)
      assert.strictEqual((yield* conflictFor(repo, 28))?.head, head)
    }).pipe(Effect.provide(machine({ spawned, behind: 3, conflicts: true })), recording(printed))
  })

  it.effect("prints the files the rebase conflicted on and writes them down beside the head", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []
    const unmerged = ["src/cli/rebase.ts", "pnpm-lock.yaml"]

    return Effect.gen(function* () {
      yield* enabled

      yield* run("rebase", "28")

      assert.include(printed.join("\n"), "2 files")
      assert.include(printed.join("\n"), "src/cli/rebase.ts")
      assert.include(printed.join("\n"), "pnpm-lock.yaml")

      const store = yield* Store.storeFor("rebases", Conflict)
      assert.deepStrictEqual(yield* store.get(Store.prKey(repo, 28)), Option.some({ head, paths: unmerged }))
    }).pipe(Effect.provide(machine({ spawned, behind: 3, conflicts: true, unmerged })), recording(printed))
  })

  it.effect("points at the command that opens a session on the conflict", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* enabled

      yield* run("rebase", "28")

      // A conflict is where the next step stops being obvious, so the step is
      // on screen as itself rather than left to be remembered.
      assert.include(printed, "  dw-mc resolve 28")
      assert.include(printed.join("\n"), "Needs me")
    }).pipe(Effect.provide(machine({ spawned, behind: 3, conflicts: true })), recording(printed))
  })

  it.effect("is off until the repository turns it on", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered

      const error = yield* Effect.flip(run("rebase", "28"))

      assert.include(String(error.cause), "Rebase is off")
      assert.deepStrictEqual(pushes(spawned), [])
    }).pipe(Effect.provide(machine({ spawned, behind: 3 })), recording(printed))
  })

  it.effect("reports a stacked pull request with its position and drives nothing", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* enabled

      const error = yield* Effect.flip(run("rebase", "28"))

      assert.include(String(error.cause), "2 of 3 in a stack")
      assert.deepStrictEqual(pushes(spawned), [])
      assert.isFalse(spawned.some((vector) => vector.includes("worktree add")))
    }).pipe(
      Effect.provide(
        machine({
          spawned,
          behind: 3,
          base: "feat/27-below",
          open: [
            { number: 27, headRefName: "feat/27-below", baseRefName: "main" },
            { number: 28, headRefName: branch, baseRefName: "feat/27-below" },
            { number: 29, headRefName: "feat/29-above", baseRefName: branch }
          ]
        })
      ),
      recording(printed)
    )
  })

  it.effect("does nothing while CI is running, so the run I wait on is not cancelled", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* enabled

      const error = yield* Effect.flip(run("rebase", "28"))

      assert.include(String(error.cause), "still running")
      assert.deepStrictEqual(pushes(spawned), [])
      assert.isFalse(spawned.some((vector) => vector.includes("worktree add")))
    }).pipe(Effect.provide(machine({ spawned, behind: 3, checks: [check(null)] })), recording(printed))
  })

  it.effect("leaves a red build where it is, because it is mine to fix", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* enabled

      const error = yield* Effect.flip(run("rebase", "28"))

      assert.include(String(error.cause), "red")
      assert.deepStrictEqual(pushes(spawned), [])
    }).pipe(Effect.provide(machine({ spawned, behind: 3, checks: [check("FAILURE")] })), recording(printed))
  })

  it.effect("refuses a branch somebody else authored", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* enabled

      const error = yield* Effect.flip(run("rebase", "28"))

      assert.include(String(error.cause), "not mine")
      assert.deepStrictEqual(pushes(spawned), [])
      assert.isFalse(spawned.some((vector) => vector.includes("worktree add")))
    }).pipe(Effect.provide(machine({ spawned, behind: 3, author: "someone-else" })), recording(printed))
  })

  it.effect("refuses a branch that lives in a fork rather than in the repository", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* enabled

      const error = yield* Effect.flip(run("rebase", "28"))

      assert.include(String(error.cause), "fork")
      assert.deepStrictEqual(pushes(spawned), [])
    }).pipe(Effect.provide(machine({ spawned, behind: 3, fromFork: true })), recording(printed))
  })

  it.effect("refuses where the open pull requests it read did not include this one", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* enabled

      const error = yield* Effect.flip(run("rebase", "28"))

      assert.include(String(error.cause), "stack")
      assert.deepStrictEqual(pushes(spawned), [])
    }).pipe(Effect.provide(machine({ spawned, behind: 3, open: [] })), recording(printed))
  })

  it.effect("works in the tool's own clone and never in my checkout", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* enabled

      yield* run("rebase", "28")

      assert.isTrue(
        spawned
          .filter((vector) => vector.startsWith("git "))
          .every((vector) => vector.startsWith(`git -C ${clone} `) || vector.startsWith(`git -C ${worktree} `)),
        spawned.join("\n")
      )
    }).pipe(Effect.provide(machine({ spawned, behind: 3 })), recording(printed))
  })

  it.effect("writes one thing to GitHub, and it is the push", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* enabled

      yield* run("rebase", "28")

      // ADR 0002: no comment, reply, thread resolve, label, review, approval,
      // status or merge - `gh pr view` and `gh pr list` cannot write, and the
      // push goes to a branch I author, with a lease.
      for (const vector of spawned.filter((spawn) => spawn.startsWith("gh "))) {
        assert.match(vector, /^gh (pr (view|list)|api user)/)
      }
      assert.deepStrictEqual(pushes(spawned), [
        `git -C ${worktree} push --force-with-lease=refs/heads/${branch}:${head} origin HEAD:refs/heads/${branch}`
      ])
    }).pipe(Effect.provide(machine({ spawned, behind: 3 })), recording(printed))
  })
})
