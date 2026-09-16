import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Path } from "effect"

import { withWorktree } from "#adapters/git.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"

const state = "/home/dw/.local/state/dw-mc"
const clone = `${state}/repos/dominikwozniak/dw-mc.git`
const worktree = `${state}/worktrees/dominikwozniak/dw-mc/28`
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"

/** What the real `git` says, captured from `git` itself. */
const said = {
  noRepository: `fatal: cannot change to '${clone}': No such file or directory\n`,
  conflict: "fatal: 'refs/pull/28/head' does not appear to be a git repository\n"
}

/** A `git` that answers from fixtures and records every vector handed to it. */
const git = (options: {
  readonly spawned: Array<string>
  /** Whether the bare clone is already there. */
  readonly cloned?: boolean | undefined
  /** The vector that refuses, and what `git` says on stderr instead. */
  readonly refuses?: { readonly argv: string; readonly detail: string } | undefined
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
    if (argv === `-C ${clone} rev-parse FETCH_HEAD`) {
      return Effect.succeed(fakeHandle({ stdout: `${head}\n` }))
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
        `git -C ${clone} fetch --no-tags --force origin refs/pull/28/head`,
        `git -C ${clone} rev-parse FETCH_HEAD`,
        `git -C ${clone} worktree remove --force ${worktree}`,
        `git -C ${clone} worktree add --detach ${worktree} ${head}`,
        `git -C ${clone} worktree remove --force ${worktree}`
      ])
    }).pipe(Effect.provide(machine(git({ spawned }))))
  })

  it.effect("clones once and fetches every run after that", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* withWorktree("dominikwozniak/dw-mc", 28, () => Effect.void)

      assert.isFalse(spawned.some((vector) => vector.startsWith("git clone")))
      assert.include(spawned, `git -C ${clone} fetch --no-tags --force origin refs/pull/28/head`)
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
    const refuses = { argv: `-C ${clone} fetch --no-tags --force origin refs/pull/28/head`, detail: said.conflict }

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
