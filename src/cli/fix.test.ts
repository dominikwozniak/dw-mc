import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Terminal } from "effect"
import type { ChildProcess } from "effect/unstable/process"

import type { ConfigFile } from "#adapters/config.ts"
import { builtInLauncher, write } from "#adapters/config.ts"
import { prViewOf } from "#adapters/gh.ts"
import { key, recording, typed } from "#adapters/picker.ts"
import { json, layerStubbed, wrote } from "#adapters/spawner.ts"
import { storeFor } from "#adapters/store.ts"
import { machineOf, run } from "#cli/cli.ts"
import type { Outcome } from "#domain/review.ts"
import { LastReviewed, latestKey, ReviewRun, runKey } from "#domain/review.ts"

/** The program a run is spawned as, which the launcher names and the default spells `claude`. */
const launching = builtInLauncher.command[0]

const repo = "dominikwozniak/dw-mc"
const branch = "feat/28-a-branch"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"
const moved = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"
const session = "befb6186-5471-4b26-b680-e8ca49df25ac"

const state = "/home/dw/.local/state/dw-mc"
const clone = `${state}/repos/${repo}.git`
const worktree = `${state}/fixes/${repo}/28`

const found: Outcome = {
  _tag: "reported",
  verdict: "findings",
  findings: [
    { file: "src/cli/review.ts", line: 88, severity: "error", summary: "The run is never recorded." },
    { file: "docs/v1-design.md", line: 3, severity: "info", summary: "The build order is out of date." }
  ]
}

/** Every program a fix session spawns, from fixtures, and a death for anything else. */
const machine = (options: {
  readonly spawned: Array<ChildProcess.StandardCommand>
  readonly keys: ReadonlyArray<Terminal.UserInput>
  readonly drawn?: Array<string> | undefined
  /** The head GitHub says the pull request is at now. */
  readonly headRefOid?: string | undefined
}) =>
  machineOf({
    keys: options.keys,
    drawn: options.drawn,
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
            return wrote(`${options.headRefOid ?? head}\n`)
          }
          if (argv === `-C ${clone} worktree list --porcelain`) {
            return wrote(`worktree ${clone}\nbare\n`)
          }
          return wrote("")
        },
        (_, argv) =>
          /^pr view 28 --repo \S+ --json \S+$/.test(argv)
            ? json(
                prViewOf(repo, {
                  number: 28,
                  title: "feat: report a review run's findings",
                  headRefOid: options.headRefOid ?? head,
                  headRefName: branch
                })
              )
            : undefined
      ]
    })
  })

const registered = (...repos: ReadonlyArray<string>) =>
  write({ repos: Object.fromEntries(repos.map((name) => [name, {}])) } satisfies ConfigFile)

/** A repository whose settings let a fix session commit what it changes. */
const committing = write({ repos: { [repo]: { fix: { commits: true } } } } satisfies ConfigFile)

/** The review run `dw-mc review` would have left behind. */
const ran = (outcome: Outcome) =>
  Effect.gen(function* () {
    const runs = yield* storeFor("runs", ReviewRun)
    const latest = yield* storeFor("runs", LastReviewed)
    yield* runs.set(runKey(repo, 28, head), {
      repo,
      number: 28,
      head,
      command: "/code-review",
      effort: "low",
      sessionId: session,
      ranAt: DateTime.makeUnsafe("2026-09-16T14:21:00Z"),
      outcome
    })
    yield* latest.set(latestKey(repo, 28), { head })
  })

/** The prompt the session was opened on, or nothing where no session was opened. */
const opened = (spawned: ReadonlyArray<ChildProcess.StandardCommand>) =>
  spawned.find((command) => command.command === launching)

/** The findings JSON the session was handed, as an object a test can read. */
const carried = (prompt: string): { readonly findings: ReadonlyArray<Record<string, unknown>> } =>
  JSON.parse(prompt.slice(prompt.indexOf("{")))

/** Picking the first finding of two: past Select All and Inverse Selection, then space. */
const first = [key("down"), key("down"), key("space")]

describe("dw-mc fix", () => {
  it.effect("opens the session on the findings I picked, and on no others", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []
    const keys = [...first, key("enter"), ...typed("the head, not the branch"), key("enter")]

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran(found)

      yield* run("fix", "28")

      const command = opened(spawned)
      assert.isDefined(command)
      assert.deepStrictEqual(carried(command?.args[0] ?? "").findings, [
        {
          file: "src/cli/review.ts",
          line: 88,
          summary: "The run is never recorded.",
          severity: "error",
          note: "the head, not the branch"
        }
      ])
    }).pipe(Effect.provide(machine({ spawned, keys })), recording(printed))
  })

  it.effect("attaches no note where I have nothing to say about a finding", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []
    const keys = [...first, key("enter"), key("enter")]

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran(found)

      yield* run("fix", "28")

      const carrying = carried(opened(spawned)?.args[0] ?? "").findings
      assert.lengthOf(carrying, 1)
      assert.notProperty(carrying[0], "note")
    }).pipe(Effect.provide(machine({ spawned, keys })), recording(printed))
  })

  it.effect("opens the session in a worktree of the tool's own clone, never in my checkout", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []
    const keys = [...first, key("enter"), key("enter")]

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran(found)

      yield* run("fix", "28")

      assert.strictEqual(opened(spawned)?.options.cwd, worktree)
      assert.include(
        spawned.map((command) => `${command.command} ${command.args.join(" ")}`),
        `git -C ${clone} worktree add -B dw-mc/fix/28 ${worktree} ${head}`
      )
      assert.include(printed.join("\n"), worktree)
    }).pipe(Effect.provide(machine({ spawned, keys })), recording(printed))
  })

  it.effect("commits nothing and pushes nothing on my behalf", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []
    const keys = [...first, key("enter"), key("enter")]

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran(found)

      yield* run("fix", "28")

      // `git config push.default` is how my own push inside the session lands
      // on the pull request, and is not the tool pushing anything.
      const vectors = spawned.map((command) => `${command.command} ${command.args.join(" ")}`)
      assert.isFalse(
        vectors.some((vector) => /^git -C \S+ (commit|push)\b/.test(vector)),
        vectors.join("\n")
      )
      assert.isDefined(opened(spawned))
    }).pipe(Effect.provide(machine({ spawned, keys })), recording(printed))
  })

  it.effect("shows the findings to pick from, one to a line", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []
    const drawn: Array<string> = []
    const keys = [...first, key("enter"), key("enter")]

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran(found)

      yield* run("fix", "28")

      const screen = drawn.join("")
      assert.include(screen, "src/cli/review.ts:88")
      assert.include(screen, "docs/v1-design.md:3")
    }).pipe(Effect.provide(machine({ spawned, keys, drawn })), recording(printed))
  })

  it.effect("keeps committing mine unless I say otherwise", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []
    const keys = [...first, key("enter"), key("enter")]

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran(found)

      yield* run("fix", "28")

      assert.include(opened(spawned)?.args[0], "Do not commit and do not push")
      assert.include(printed.join("\n"), "not committing")
    }).pipe(Effect.provide(machine({ spawned, keys })), recording(printed))
  })

  it.effect("lets the session commit where the flag says so", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []
    const keys = [...first, key("enter"), key("enter")]

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran(found)

      yield* run("fix", "28", "--commit")

      assert.include(opened(spawned)?.args[0], "Commit what you change")
    }).pipe(Effect.provide(machine({ spawned, keys })), recording(printed))
  })

  it.effect("lets the session commit where the repository is configured for it", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []
    const keys = [...first, key("enter"), key("enter")]

    return Effect.gen(function* () {
      yield* committing
      yield* ran(found)

      yield* run("fix", "28")

      assert.include(opened(spawned)?.args[0], "Commit what you change")
      assert.include(printed.join("\n"), ", committing")
    }).pipe(Effect.provide(machine({ spawned, keys })), recording(printed))
  })

  it.effect("prints the prompt and opens nothing where I am already in a session", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []
    const keys = [...first, key("enter"), key("enter")]

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran(found)

      yield* run("fix", "28", "--print")

      assert.isUndefined(opened(spawned))
      assert.isFalse(spawned.some((command) => command.command === "git"))
      const prompt = printed.at(-1) ?? ""
      assert.include(prompt, "These are the findings I picked")
      assert.deepStrictEqual(carried(prompt).findings, [
        { file: "src/cli/review.ts", line: 88, summary: "The run is never recorded.", severity: "error" }
      ])
    }).pipe(Effect.provide(machine({ spawned, keys })), recording(printed))
  })

  it.effect("opens no session where I picked nothing", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran(found)

      yield* run("fix", "28")

      assert.isUndefined(opened(spawned))
      assert.include(printed.join("\n"), "Nothing picked")
    }).pipe(Effect.provide(machine({ spawned, keys: [key("enter")] })), recording(printed))
  })

  it.effect("opens no session where I quit part way through the notes", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran(found)

      // The keys run out at the note prompt, which is what a Ctrl-C there is.
      yield* run("fix", "28")

      assert.isUndefined(opened(spawned))
      assert.include(printed.join("\n"), "Nothing picked")
    }).pipe(Effect.provide(machine({ spawned, keys: [...first, key("enter")] })), recording(printed))
  })

  it.effect("opens no session where I quit the picker", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran(found)

      yield* run("fix", "28")

      assert.isUndefined(opened(spawned))
    }).pipe(Effect.provide(machine({ spawned, keys: [] })), recording(printed))
  })

  it.effect("has nothing to fix where the run came back clean", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran({ _tag: "reported", verdict: "clean", findings: [] })

      yield* run("fix", "28")

      assert.isUndefined(opened(spawned))
      assert.include(printed.join("\n"), "clean, nothing to fix")
    }).pipe(Effect.provide(machine({ spawned, keys: [] })), recording(printed))
  })

  it.effect("stops where the head has moved since the run, so no session fixes a stale finding", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []
    const keys = [...first, key("enter"), key("enter")]

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* ran(found)

      const error = yield* Effect.flip(run("fix", "28"))

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "284d599")
      assert.include(error.message, "dw-mc review 28")
      assert.isUndefined(opened(spawned))
    }).pipe(Effect.provide(machine({ spawned, keys, headRefOid: moved })), recording(printed))
  })

  it.effect("says what to run where the pull request has had no review run", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      const error = yield* Effect.flip(run("fix", "28"))

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "No review run")
      assert.isUndefined(opened(spawned))
    }).pipe(Effect.provide(machine({ spawned, keys: [] })), recording(printed))
  })
})
