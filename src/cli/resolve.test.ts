import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { ChildProcess } from "effect/unstable/process"

import type { ConfigFile } from "#adapters/config.ts"
import { builtInLauncher, write } from "#adapters/config.ts"
import { prViewOf } from "#adapters/gh.ts"
import { recording } from "#adapters/picker.ts"
import { json, layerStubbed, refused, vectorOf, wrote } from "#adapters/spawner.ts"
import { machineOf, run } from "#cli/cli.ts"
import { recordConflict } from "#domain/rebase.ts"

/** The program a session is spawned as, which the launcher names and the default spells `claude`. */
const launching = builtInLauncher.command[0]

const repo = "dominikwozniak/dw-mc"
const branch = "feat/28-a-branch"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"
const moved = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"

const state = "/home/dw/.local/state/dw-mc"
const clone = `${state}/repos/${repo}.git`
const worktree = `${state}/rebases/${repo}/28`

const conflicting = ["src/cli/rebase.ts", "pnpm-lock.yaml"]

/** Every program the command spawns, from fixtures, and a death for anything else. */
const machine = (options: {
  readonly spawned: Array<ChildProcess.StandardCommand>
  /** The files the replay in the standing worktree leaves unmerged. */
  readonly unmerged?: ReadonlyArray<string> | undefined
  /** Whether the replay in the standing worktree stops at all. */
  readonly conflicts?: boolean | undefined
  /** Who opened the pull request, where it was not me. */
  readonly author?: string | undefined
  /** Whether the head branch lives in a fork. */
  readonly fromFork?: boolean | undefined
  /** The branch the pull request merges into. */
  readonly base?: string | undefined
  /** Every open pull request on the repository, by branch. */
  readonly open?: ReadonlyArray<{ number: number; headRefName: string; baseRefName: string }> | undefined
}) => {
  const base = options.base ?? "main"
  return machineOf({
    spawner: layerStubbed({
      onSpawn: (command) => options.spawned.push(command),
      stubs: [
        (command) => (command.command === launching ? wrote("") : undefined),
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
          if (argv === `-C ${clone} rev-parse --verify --quiet refs/heads/dw-mc/rebase/28`) {
            return refused("")
          }
          if (argv === `-C ${clone} worktree list --porcelain`) {
            return wrote(`worktree ${clone}\nbare\n`)
          }
          if (argv === `-C ${worktree} rebase refs/heads/${base}` && options.conflicts !== false) {
            return refused("CONFLICT (content): Merge conflict in a.ts\n")
          }
          if (argv === `-C ${worktree} diff --name-only --diff-filter=U`) {
            const unmerged = options.conflicts === false ? [] : (options.unmerged ?? conflicting)
            return wrote(unmerged.map((path) => `${path}\n`).join(""))
          }
          return wrote("")
        },
        (_, argv) =>
          /^pr view 28 --repo \S+ --json \S+$/.test(argv)
            ? json(
                prViewOf(repo, {
                  number: 28,
                  title: "feat: record what a rebase conflict hit",
                  headRefOid: head,
                  headRefName: branch,
                  baseRefName: base,
                  author: options.author,
                  isCrossRepository: options.fromFork,
                  mergeable: "CONFLICTING"
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

const registered = write({ repos: { [repo]: {} } } satisfies ConfigFile)

/** The conflict `dw-mc rebase` would have written down, at the head the pull request is at. */
const conflicted = (at: string = head) => recordConflict(repo, 28, at, conflicting)

/** The session that was opened, or nothing where none was. */
const opened = (spawned: ReadonlyArray<ChildProcess.StandardCommand>) =>
  spawned.find((command) => command.command === launching)

/** The conflict JSON the session was handed, as an object a test can read. */
const carried = (prompt: string): { readonly paths: ReadonlyArray<string> } =>
  JSON.parse(prompt.slice(prompt.indexOf("{")))

const vectorsOf = (spawned: ReadonlyArray<ChildProcess.StandardCommand>) => spawned.map(vectorOf)

describe("dw-mc resolve", () => {
  it.effect("cuts a worktree on dw-mc/rebase/28 that tracks the pull request's branch", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* conflicted()

      yield* run("resolve", "28")

      const vectors = vectorsOf(spawned)
      assert.include(vectors, `git -C ${clone} worktree add -B dw-mc/rebase/28 ${worktree} ${head}`)
      assert.include(vectors, `git -C ${clone} config branch.dw-mc/rebase/28.merge refs/heads/${branch}`)
      assert.include(vectors, `git -C ${worktree} config --worktree push.default upstream`)
      assert.strictEqual(opened(spawned)?.options.cwd, worktree)
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("stops the replay on the conflict and prints what it stopped on", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* conflicted()

      yield* run("resolve", "28")

      assert.include(vectorsOf(spawned), `git -C ${worktree} rebase refs/heads/main`)
      assert.isFalse(vectorsOf(spawned).some((vector) => vector.includes("rebase --abort")))
      assert.include(printed.join("\n"), "src/cli/rebase.ts")
      assert.include(printed.join("\n"), "pnpm-lock.yaml")
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("hands the session what conflicted, and resolves nothing itself", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* conflicted()

      yield* run("resolve", "28")

      const prompt = opened(spawned)?.args.at(-1) ?? ""
      assert.deepStrictEqual(carried(prompt).paths, conflicting)
      assert.include(prompt, "feat: record what a rebase conflict hit")
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("prints the prompt and opens nothing at all with --print", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* conflicted()

      yield* run("resolve", "28", "--print")

      assert.include(printed.join("\n"), "src/cli/rebase.ts")
      assert.isUndefined(opened(spawned))
      assert.isFalse(vectorsOf(spawned).some((vector) => vector.includes("worktree add")))
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("ends on the three lines that finish the job, ready to paste", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* conflicted()

      yield* run("resolve", "28")

      // The rebase stands and finishing it is mine, so what is left to run is
      // on screen as itself rather than described in a sentence.
      const at = printed.indexOf(`  cd ${worktree}`)
      assert.deepStrictEqual(printed.slice(at, at + 3), [`  cd ${worktree}`, "  git rebase --continue", "  git push"])
      assert.include(printed.join("\n"), "The session is over.")
      assert.include(printed.join("\n"), "the rebase stands where it stopped")
      assert.include(printed.at(-1), "dw-mc review 28")
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("commits nothing and pushes nothing on my behalf", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* conflicted()

      yield* run("resolve", "28")

      // `git config push.default` is how my own push inside the session lands
      // on the pull request, and is not the tool pushing anything.
      // What the session was told to leave alone says so in the prompt, so only
      // what `git` was really run with counts here.
      const vectors = vectorsOf(spawned).filter((vector) => vector.startsWith("git "))
      assert.isFalse(
        vectors.some((vector) => /^git -C \S+ (commit|push)\b/.test(vector)),
        vectors.join("\n")
      )
      assert.isFalse(vectors.some((vector) => vector.includes("rebase --continue")))
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("opens no session where the replay went through, which is rerere having done it", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* conflicted()

      yield* run("resolve", "28")

      assert.isUndefined(opened(spawned))
      assert.include(printed.join("\n"), "nothing to resolve")
    }).pipe(Effect.provide(machine({ spawned, conflicts: false })), recording(printed))
  })

  it.effect("sends a pull request with no conflict at its head to dw-mc rebase", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered

      const error = yield* Effect.flip(run("resolve", "28"))

      assert.include(String(error.cause), "dw-mc rebase 28")
      assert.isUndefined(opened(spawned))
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("sends a pull request whose branch moved past its conflict to dw-mc rebase", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* conflicted(moved)

      const error = yield* Effect.flip(run("resolve", "28"))

      assert.include(String(error.cause), "dw-mc rebase 28")
      assert.isFalse(vectorsOf(spawned).some((vector) => vector.includes("worktree add")))
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("refuses a pull request somebody else opened", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* conflicted()

      const error = yield* Effect.flip(run("resolve", "28"))

      assert.include(String(error.cause), "not mine")
      assert.isUndefined(opened(spawned))
    }).pipe(Effect.provide(machine({ spawned, author: "somebody" })), recording(printed))
  })

  it.effect("refuses a pull request opened from a fork", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* conflicted()

      const error = yield* Effect.flip(run("resolve", "28"))

      assert.include(String(error.cause), "fork")
      assert.isUndefined(opened(spawned))
    }).pipe(Effect.provide(machine({ spawned, fromFork: true })), recording(printed))
  })

  it.effect("refuses a stacked pull request and drives nothing", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* conflicted()

      const error = yield* Effect.flip(run("resolve", "28"))

      assert.include(String(error.cause), "2 of 3 in a stack")
      assert.isUndefined(opened(spawned))
    }).pipe(
      Effect.provide(
        machine({
          spawned,
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

  it.effect("says nothing about rebase.enabled, which is about a push it never makes", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      // The repository has not turned rebase on, and this still opens: the key
      // guards a force push, and the only push here is mine.
      yield* registered
      yield* conflicted()

      yield* run("resolve", "28")

      assert.isDefined(opened(spawned))
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })
})
