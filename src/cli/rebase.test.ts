import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Console, Effect, FileSystem, Layer, Path, Stdio } from "effect"
import { Command } from "effect/unstable/cli"

import type { ConfigFile } from "#adapters/config.ts"
import { ConfigStore, write } from "#adapters/config.ts"
import { layerScripted } from "#adapters/picker.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"
import * as Store from "#adapters/store.ts"
import { dwMc, version } from "#cli/cli.ts"
import { conflictedAt } from "#domain/rebase.ts"

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
}) => {
  const base = options.base ?? "main"
  const spawner = layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("rebase.test: the fake was handed a piped command")
    }
    const argv = command.args.join(" ")
    options.spawned.push(`${command.command} ${argv}`)

    if (command.command === "git") {
      if (argv === `-C ${clone} rev-parse --is-bare-repository`) {
        return Effect.succeed(fakeHandle({ stdout: "true\n" }))
      }
      if (argv === `-C ${clone} rev-parse refs/dw-mc/pr/28`) {
        return Effect.succeed(fakeHandle({ stdout: `${head}\n` }))
      }
      if (argv === `-C ${worktree} rev-list --count HEAD..refs/heads/${base}`) {
        return Effect.succeed(fakeHandle({ stdout: `${options.behind ?? 0}\n` }))
      }
      if (argv === `-C ${worktree} rebase refs/heads/${base}` && options.conflicts === true) {
        return Effect.succeed(fakeHandle({ exitCode: 1, stderr: "CONFLICT (content): Merge conflict in a.ts\n" }))
      }
      if (argv === `-C ${worktree} rev-parse HEAD`) {
        return Effect.succeed(fakeHandle({ stdout: `${rebased}\n` }))
      }
      return Effect.succeed(fakeHandle({}))
    }
    if (/^pr view 28 --repo \S+ --json \S+$/.test(argv)) {
      return Effect.succeed(
        fakeHandle({
          stdout: JSON.stringify({
            number: 28,
            title: "feat: rebase one branch",
            url: `https://github.com/${repo}/pull/28`,
            isDraft: false,
            headRefOid: head,
            headRefName: branch,
            baseRefName: base,
            mergeable: "MERGEABLE",
            reviewDecision: "",
            statusCheckRollup: options.checks ?? []
          })
        })
      )
    }
    if (/^pr list --repo \S+ --state open/.test(argv)) {
      return Effect.succeed(
        fakeHandle({
          stdout: JSON.stringify(options.open ?? [{ number: 28, headRefName: branch, baseRefName: base }])
        })
      )
    }
    return Effect.die(`rebase.test: nothing stubbed for '${command.command} ${argv}'`)
  })

  return Layer.provideMerge(
    Layer.mergeAll(ConfigStore.layerTest, Store.layerTest),
    Layer.mergeAll(
      ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/home/dw" })),
      FileSystem.layerNoop({}),
      Path.layer,
      Stdio.layerTest({}),
      spawner,
      layerScripted([])
    )
  )
}

const recording = (printed: Array<string>) => {
  const console_: Console.Console = Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
    error: () => {}
  })
  return Effect.provideService(Console.Console, console_)
}

/** A repository that has turned rebase on, which is off until it does. */
const enabled = write({ repos: { [repo]: { rebase: { enabled: true } } } } satisfies ConfigFile)
const registered = write({ repos: { [repo]: {} } } satisfies ConfigFile)

const run = (...argv: ReadonlyArray<string>) => Command.runWith(dwMc, { version })(argv)

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
      assert.strictEqual(yield* conflictedAt(repo, 28), head)
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
        assert.match(vector, /^gh pr (view|list) /)
      }
      assert.deepStrictEqual(pushes(spawned), [
        `git -C ${worktree} push --force-with-lease=refs/heads/${branch}:${head} origin HEAD:refs/heads/${branch}`
      ])
    }).pipe(Effect.provide(machine({ spawned, behind: 3 })), recording(printed))
  })
})
