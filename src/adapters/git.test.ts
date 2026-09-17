import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Path } from "effect"

import { fixWorktree, rebaseOnto, withWorktree } from "#adapters/git.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"

const state = "/home/dw/.local/state/dw-mc"
const clone = `${state}/repos/dominikwozniak/dw-mc.git`
const worktree = `${state}/worktrees/dominikwozniak/dw-mc/28`
const fix = `${state}/fixes/dominikwozniak/dw-mc/28`
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"
const rebased = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"
const fetched = `-C ${clone} fetch --no-tags --force origin +refs/pull/28/head:refs/dw-mc/pr/28 +refs/heads/*:refs/heads/*`

/** What the real `git` says, captured from `git` itself. */
const said = {
  noRepository: `fatal: cannot change to '${clone}': No such file or directory\n`,
  conflict: "fatal: 'refs/pull/28/head' does not appear to be a git repository\n",
  rebaseConflict: "CONFLICT (content): Merge conflict in src/cli/rebase.ts\n",
  noIdentity: "fatal: empty ident name not allowed\n",
  noRebase: "fatal: No rebase in progress?\n"
}

/** A `git` that answers from fixtures and records every vector handed to it. */
const git = (options: {
  readonly spawned: Array<string>
  /** Whether the bare clone is already there. */
  readonly cloned?: boolean | undefined
  /** The vector that refuses, and what `git` says on stderr instead. */
  readonly refuses?: { readonly argv: string; readonly detail: string } | undefined
  /** The worktrees the clone already knows about. */
  readonly worktrees?: ReadonlyArray<string> | undefined
  /**
   * How far the fix branch has gone past the head, where the clone has that
   * branch at all. Left out, the branch is not there.
   */
  readonly ahead?: number | undefined
  /** How many commits the base has that the pull request's head does not. */
  readonly behind?: number | undefined
  /** The files a conflicted replay left unmerged in the worktree. */
  readonly unmerged?: ReadonlyArray<string> | undefined
}) =>
  layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("git.test: the fake was handed a piped command")
    }
    const argv = command.args.join(" ")
    options.spawned.push(`${command.command} ${argv}`)

    if (options.refuses?.argv === argv) {
      return Effect.succeed(fakeHandle({ exitCode: 128, stderr: options.refuses.detail }))
    }
    if (argv === `-C ${clone} rev-parse --is-bare-repository`) {
      return options.cloned === true
        ? Effect.succeed(fakeHandle({ stdout: "true\n" }))
        : Effect.succeed(fakeHandle({ exitCode: 128, stderr: said.noRepository }))
    }
    if (argv === `-C ${clone} rev-parse refs/dw-mc/pr/28`) {
      return Effect.succeed(fakeHandle({ stdout: `${head}\n` }))
    }
    if (argv === `-C ${clone} rev-parse --verify --quiet refs/heads/dw-mc/fix/28`) {
      return options.ahead === undefined
        ? Effect.succeed(fakeHandle({ exitCode: 1 }))
        : Effect.succeed(fakeHandle({ stdout: `${head}\n` }))
    }
    if (argv === `-C ${clone} rev-list --count refs/heads/dw-mc/fix/28 ^${head}`) {
      return Effect.succeed(fakeHandle({ stdout: `${options.ahead ?? 0}\n` }))
    }
    if (argv === `-C ${worktree} rev-list --count HEAD..refs/heads/main`) {
      return Effect.succeed(fakeHandle({ stdout: `${options.behind ?? 0}\n` }))
    }
    if (argv === `-C ${worktree} rev-parse HEAD`) {
      return Effect.succeed(fakeHandle({ stdout: `${rebased}\n` }))
    }
    if (argv === `-C ${worktree} diff --name-only --diff-filter=U`) {
      return Effect.succeed(fakeHandle({ stdout: (options.unmerged ?? []).map((path) => `${path}\n`).join("") }))
    }
    if (argv === `-C ${clone} worktree list --porcelain`) {
      const listed = (options.worktrees ?? []).map((directory) => `worktree ${directory}\nbare\n`)
      return Effect.succeed(fakeHandle({ stdout: [`worktree ${clone}\nbare\n`, ...listed].join("\n") }))
    }
    return Effect.succeed(fakeHandle({}))
  })

const machine = (spawner: Layer.Layer<never> | ReturnType<typeof git>) =>
  Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/home/dw" })), Path.layer, spawner)

describe("the tool's own clone and its throwaway worktree", () => {
  it.effect("cuts the worktree at the pull request's head and takes it down after", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      const cut = yield* withWorktree("dominikwozniak/dw-mc", 28, (worktree_) => Effect.succeed(worktree_))

      assert.deepStrictEqual(cut, { directory: worktree, head })
      assert.deepStrictEqual(spawned, [
        `git -C ${clone} rev-parse --is-bare-repository`,
        `git clone --bare --filter=blob:none https://github.com/dominikwozniak/dw-mc.git ${clone}`,
        `git ${fetched}`,
        `git -C ${clone} rev-parse refs/dw-mc/pr/28`,
        `git -C ${clone} worktree remove --force ${worktree}`,
        `git -C ${clone} worktree add --detach ${worktree} ${head}`,
        `git -C ${clone} worktree remove --force ${worktree}`
      ])
    }).pipe(Effect.provide(machine(git({ spawned }))))
  })

  it.effect("brings the base branch up to date with the pull request's head", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* withWorktree("dominikwozniak/dw-mc", 28, () => Effect.void)

      // A bare clone is made with no refspec, so nothing else moves `main` on:
      // a review diffing against it would report every commit since the clone.
      assert.include(spawned, `git ${fetched}`)
      assert.include(fetched, "+refs/heads/*:refs/heads/*")
    }).pipe(Effect.provide(machine(git({ spawned, cloned: true }))))
  })

  it.effect("clones once and fetches every run after that", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* withWorktree("dominikwozniak/dw-mc", 28, () => Effect.void)

      assert.isFalse(spawned.some((vector) => vector.startsWith("git clone")))
      assert.include(spawned, `git ${fetched}`)
    }).pipe(Effect.provide(machine(git({ spawned, cloned: true }))))
  })

  it.effect("takes the worktree down when the run failed", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        withWorktree("dominikwozniak/dw-mc", 28, () => Effect.fail("the runner gave up" as const))
      )

      assert.strictEqual(error, "the runner gave up")
      assert.strictEqual(spawned.at(-1), `git -C ${clone} worktree remove --force ${worktree}`)
    }).pipe(Effect.provide(machine(git({ spawned, cloned: true }))))
  })

  it.effect("never reaches outside the state directory", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* withWorktree("dominikwozniak/dw-mc", 28, () => Effect.void)

      assert.isTrue(
        spawned.every((vector) => vector.startsWith(`git -C ${clone} `) || vector.startsWith("git clone --bare")),
        spawned.join("\n")
      )
    }).pipe(Effect.provide(machine(git({ spawned }))))
  })

  it.effect("hands on what git said when git refuses", () => {
    const spawned: Array<string> = []
    const refuses = { argv: fetched, detail: said.conflict }

    return Effect.gen(function* () {
      const error = yield* Effect.flip(withWorktree("dominikwozniak/dw-mc", 28, () => Effect.void))

      if (error._tag !== "GitFailed") {
        return assert.fail(`expected a GitFailed, got ${error._tag}`)
      }
      assert.include(error.message, "does not appear to be a git repository")
      assert.include(error.message, "fetch")
      assert.isFalse(spawned.some((vector) => vector.includes("worktree add")))
    }).pipe(Effect.provide(machine(git({ spawned, cloned: true, refuses }))))
  })
})

describe("the worktree a fix session opens in", () => {
  it.effect("cuts it on a branch of the tool's own that tracks the pull request's", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      const cut = yield* fixWorktree("dominikwozniak/dw-mc", 28, "feat/28-a-branch")

      assert.deepStrictEqual(cut, { directory: fix, head })
      assert.deepStrictEqual(spawned, [
        `git -C ${clone} rev-parse --is-bare-repository`,
        `git ${fetched}`,
        `git -C ${clone} rev-parse refs/dw-mc/pr/28`,
        `git -C ${clone} rev-parse --verify --quiet refs/heads/dw-mc/fix/28`,
        `git -C ${clone} worktree list --porcelain`,
        `git -C ${clone} config extensions.worktreeConfig true`,
        `git -C ${clone} config --worktree core.bare true`,
        `git -C ${clone} config --unset core.bare`,
        `git -C ${clone} worktree add -B dw-mc/fix/28 ${fix} ${head}`,
        `git -C ${clone} config branch.dw-mc/fix/28.remote origin`,
        `git -C ${clone} config branch.dw-mc/fix/28.merge refs/heads/feat/28-a-branch`,
        `git -C ${fix} config --worktree push.default upstream`
      ])
    }).pipe(Effect.provide(machine(git({ spawned, cloned: true }))))
  })

  it.effect("never stands on the pull request's own branch, which the next fetch would refuse", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* fixWorktree("dominikwozniak/dw-mc", 28, "feat/28-a-branch")

      // Verified by running it: `git` refuses to fetch into a branch a worktree
      // has checked out, and this clone fetches every branch on every run.
      const cut = spawned.find((vector) => vector.includes("worktree add"))
      assert.include(cut, "-B dw-mc/fix/28")
      assert.notInclude(cut, "feat/28-a-branch")
    }).pipe(Effect.provide(machine(git({ spawned, cloned: true }))))
  })

  it.effect("keeps how a push behaves to the fix worktree, out of the clone every run shares", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* fixWorktree("dominikwozniak/dw-mc", 28, "feat/28-a-branch")

      assert.include(spawned, `git -C ${fix} config --worktree push.default upstream`)
      assert.isFalse(spawned.some((vector) => vector === `git -C ${clone} config push.default upstream`))
    }).pipe(Effect.provide(machine(git({ spawned, cloned: true }))))
  })

  it.effect("cuts the previous session's worktree away first, where it is finished with", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* fixWorktree("dominikwozniak/dw-mc", 28, "feat/28-a-branch")

      assert.include(spawned, `git -C ${clone} worktree remove ${fix}`)
      assert.isFalse(spawned.some((vector) => vector.includes("worktree remove --force")))
    }).pipe(Effect.provide(machine(git({ spawned, cloned: true, worktrees: [fix] }))))
  })

  it.effect("stops rather than throwing away changes a previous session left uncommitted", () => {
    const spawned: Array<string> = []
    const refuses = {
      argv: `-C ${clone} worktree remove ${fix}`,
      detail: `fatal: '${fix}' contains modified or untracked files, use --force to delete it\n`
    }

    return Effect.gen(function* () {
      const error = yield* Effect.flip(fixWorktree("dominikwozniak/dw-mc", 28, "feat/28-a-branch"))

      assert.strictEqual(error._tag, "GitFailed")
      assert.include(error.message, "contains modified or untracked files")
      assert.isFalse(spawned.some((vector) => vector.includes("worktree add")))
    }).pipe(Effect.provide(machine(git({ spawned, cloned: true, worktrees: [fix], refuses }))))
  })

  it.effect("stops rather than resetting a branch over commits I have not pushed", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(fixWorktree("dominikwozniak/dw-mc", 28, "feat/28-a-branch"))

      if (error._tag !== "WorktreeHeld") {
        return assert.fail(`expected a WorktreeHeld, got ${error._tag}`)
      }
      assert.include(error.message, "2 commits")
      assert.include(error.message, fix)
      assert.isFalse(spawned.some((vector) => vector.includes("worktree remove")))
      assert.isFalse(spawned.some((vector) => vector.includes("worktree add")))
    }).pipe(Effect.provide(machine(git({ spawned, cloned: true, worktrees: [fix], ahead: 2 }))))
  })

  it.effect("stops on those commits even where the worktree they were made in is gone", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      // The directory can be pruned or removed by hand; the branch that holds
      // the commits stays, and `worktree add -B` would reset it to the head.
      const error = yield* Effect.flip(fixWorktree("dominikwozniak/dw-mc", 28, "feat/28-a-branch"))

      if (error._tag !== "WorktreeHeld") {
        return assert.fail(`expected a WorktreeHeld, got ${error._tag}`)
      }
      assert.include(error.message, "2 commits")
      assert.isFalse(spawned.some((vector) => vector.includes("worktree add")))
    }).pipe(Effect.provide(machine(git({ spawned, cloned: true, worktrees: [], ahead: 2 }))))
  })
})

describe("rebasing a branch onto its base", () => {
  it.effect("leaves a branch that is already on its base alone", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      const done = yield* rebaseOnto("dominikwozniak/dw-mc", 28, "main", "feat/28-a-branch")

      assert.deepStrictEqual(done, { _tag: "up-to-date" })
      assert.isFalse(spawned.some((vector) => vector.includes(" rebase ") || vector.includes(" push ")))
    }).pipe(Effect.provide(machine(git({ spawned, cloned: true, behind: 0 }))))
  })

  it.effect("rebases a branch that is behind and pushes it with a lease on the head it read", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      const done = yield* rebaseOnto("dominikwozniak/dw-mc", 28, "main", "feat/28-a-branch")

      assert.deepStrictEqual(done, { _tag: "pushed", before: head, after: rebased, behind: 3 })
      assert.include(spawned, `git -C ${worktree} rebase refs/heads/main`)
      assert.include(
        spawned,
        `git -C ${worktree} push --force-with-lease=refs/heads/feat/28-a-branch:${head} ` +
          `origin HEAD:refs/heads/feat/28-a-branch`
      )
    }).pipe(Effect.provide(machine(git({ spawned, cloned: true, behind: 3 }))))
  })

  it.effect("aborts on a conflict, pushes nothing, and leaves no rebase half done", () => {
    const spawned: Array<string> = []
    const refuses = { argv: `-C ${worktree} rebase refs/heads/main`, detail: said.rebaseConflict }

    return Effect.gen(function* () {
      const done = yield* rebaseOnto("dominikwozniak/dw-mc", 28, "main", "feat/28-a-branch")

      assert.deepStrictEqual(done, { _tag: "conflicted", paths: ["src/cli/rebase.ts", "pnpm-lock.yaml"] })
      assert.include(spawned, `git -C ${worktree} rebase --abort`)
      assert.isFalse(spawned.some((vector) => vector.includes(" push ")))
      assert.strictEqual(spawned.at(-1), `git -C ${clone} worktree remove --force ${worktree}`)
    }).pipe(
      Effect.provide(
        machine(git({ spawned, cloned: true, behind: 3, refuses, unmerged: ["src/cli/rebase.ts", "pnpm-lock.yaml"] }))
      )
    )
  })

  it.effect("reads the unmerged files while the conflict is still there, before the abort", () => {
    const spawned: Array<string> = []
    const refuses = { argv: `-C ${worktree} rebase refs/heads/main`, detail: said.rebaseConflict }

    return Effect.gen(function* () {
      yield* rebaseOnto("dominikwozniak/dw-mc", 28, "main", "feat/28-a-branch")

      // An abort puts the branch back, and with it every unmerged path: read
      // after it, the conflict record would carry nothing.
      assert.include(spawned, `git -C ${worktree} diff --name-only --diff-filter=U`)
      assert.isBelow(
        spawned.indexOf(`git -C ${worktree} diff --name-only --diff-filter=U`),
        spawned.indexOf(`git -C ${worktree} rebase --abort`)
      )
    }).pipe(
      Effect.provide(machine(git({ spawned, cloned: true, behind: 3, refuses, unmerged: ["src/cli/rebase.ts"] })))
    )
  })

  it.effect("reports a rebase that never started as what it is, and not as a conflict", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      // Only a rebase in progress can be aborted, so an abort that refuses says
      // the replay never began: nothing conflicted, and the reason is git's own.
      const error = yield* Effect.flip(rebaseOnto("dominikwozniak/dw-mc", 28, "main", "feat/28-a-branch"))

      assert.strictEqual(error._tag, "GitFailed")
      assert.include(error.message, "empty ident name")
      assert.isFalse(spawned.some((vector) => vector.includes(" push ")))
    }).pipe(
      Effect.provide(
        machine(
          layerFake((command) => {
            if (command._tag !== "StandardCommand") {
              return Effect.die("git.test: the fake was handed a piped command")
            }
            const argv = command.args.join(" ")
            spawned.push(`${command.command} ${argv}`)
            if (argv === `-C ${clone} rev-parse --is-bare-repository`) {
              return Effect.succeed(fakeHandle({ stdout: "true\n" }))
            }
            if (argv === `-C ${clone} rev-parse refs/dw-mc/pr/28`) {
              return Effect.succeed(fakeHandle({ stdout: `${head}\n` }))
            }
            if (argv === `-C ${worktree} rev-list --count HEAD..refs/heads/main`) {
              return Effect.succeed(fakeHandle({ stdout: "3\n" }))
            }
            if (argv === `-C ${worktree} rebase refs/heads/main`) {
              return Effect.succeed(fakeHandle({ exitCode: 128, stderr: said.noIdentity }))
            }
            if (argv === `-C ${worktree} rebase --abort`) {
              return Effect.succeed(fakeHandle({ exitCode: 128, stderr: said.noRebase }))
            }
            return Effect.succeed(fakeHandle({}))
          })
        )
      )
    )
  })

  it.effect("works in the throwaway worktree and never in my own checkout", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* rebaseOnto("dominikwozniak/dw-mc", 28, "main", "feat/28-a-branch")

      assert.isTrue(
        spawned.every((vector) => vector.startsWith(`git -C ${clone} `) || vector.startsWith(`git -C ${worktree} `)),
        spawned.join("\n")
      )
    }).pipe(Effect.provide(machine(git({ spawned, cloned: true, behind: 3 }))))
  })
})
