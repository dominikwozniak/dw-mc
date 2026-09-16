import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Console, Effect, FileSystem, Layer, Option, Path, Stdio } from "effect"
import { Command } from "effect/unstable/cli"

import type { ConfigFile } from "#adapters/config.ts"
import { ConfigStore, write } from "#adapters/config.ts"
import { layerScripted } from "#adapters/picker.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"
import * as Store from "#adapters/store.ts"
import { storeFor, textStoreFor } from "#adapters/store.ts"
import { dwMc, version } from "#cli/cli.ts"
import { reportKey, ReviewRun, runKey } from "#domain/review.ts"

const me = "dominikwozniak"
const repo = "dominikwozniak/dw-mc"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"
const session = "befb6186-5471-4b26-b680-e8ca49df25ac"
const title = "build(lint): hold the ADR invariants"
const report = "## Standards\n\n1. The write boundary fails open on an unreadable flag."

const state = "/home/dw/.local/state/dw-mc"
const clone = `${state}/repos/${repo}.git`
const worktree = `${state}/worktrees/${repo}/28`

/** The events `claude --output-format stream-json` emits, as it emits them. */
const transcript = (result: Record<string, unknown>) =>
  [
    { type: "system", subtype: "init", session_id: session },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Agent" }] } },
    result
  ]
    .map((event) => JSON.stringify(event))
    .join("\n")

const finished = transcript({
  type: "result",
  subtype: "success",
  is_error: false,
  result: report,
  session_id: session,
  num_turns: 7
})

/**
 * Every program a review run spawns, from fixtures, and a death for anything
 * else - which is what keeps the run's reach over my machine honest.
 */
const machine = (options: {
  readonly spawned: Array<string>
  readonly drawn?: Array<string> | undefined
  /** What `claude` prints, and what it exits with. */
  readonly runner?: { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number } | undefined
  /** The pull requests `gh` knows about, by repository. */
  readonly repos?: Record<string, ReadonlyArray<number>> | undefined
}) => {
  const spawner = layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("review.test: the fake was handed a piped command")
    }
    const argv = command.args.join(" ")
    options.spawned.push(`${command.command} ${argv}`)
    const json = (value: unknown) => Effect.succeed(fakeHandle({ stdout: JSON.stringify(value) }))

    if (command.command === "claude") {
      return Effect.succeed(
        fakeHandle({
          stdout: options.runner?.stdout ?? finished,
          stderr: options.runner?.stderr,
          exitCode: options.runner?.exitCode
        })
      )
    }
    if (command.command === "osascript") {
      return Effect.succeed(fakeHandle({}))
    }
    if (command.command === "git") {
      if (argv === `-C ${clone} rev-parse --is-bare-repository`) {
        return Effect.succeed(fakeHandle({ stdout: "true\n" }))
      }
      if (argv === `-C ${clone} rev-parse FETCH_HEAD`) {
        return Effect.succeed(fakeHandle({ stdout: `${head}\n` }))
      }
      return Effect.succeed(fakeHandle({}))
    }

    if (argv === "api user") {
      return json({ login: me })
    }
    const search = /^search prs --author=@me --state=open --repo (\S+) --limit 100 --json number,repository$/.exec(argv)
    if (search !== null) {
      const found = options.repos?.[search[1] ?? ""] ?? []
      return json(found.map((number) => ({ number, repository: { nameWithOwner: search[1] } })))
    }
    const detail = /^pr view (\d+) --repo (\S+) --json (\S+)$/.exec(argv)
    if (detail !== null) {
      const [, number = "", named = "", fields = ""] = detail
      if (fields === "commits") {
        return json({ commits: [] })
      }
      return json({
        number: Number(number),
        title,
        url: `https://github.com/${named}/pull/${number}`,
        isDraft: false,
        headRefOid: head,
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        statusCheckRollup: [{ name: "Check", status: "COMPLETED", conclusion: "SUCCESS" }]
      })
    }
    if (/^api repos\/\S+\/(issues|pulls)\/\d+\/(comments|reviews)\?per_page=100$/.test(argv)) {
      return json([])
    }
    return Effect.die(`review.test: nothing stubbed for '${command.command} ${argv}'`)
  })

  return Layer.provideMerge(
    Layer.mergeAll(ConfigStore.layerTest, Store.layerTest),
    Layer.mergeAll(
      ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/home/dw" })),
      FileSystem.layerNoop({}),
      Path.layer,
      Stdio.layerTest({}),
      spawner,
      layerScripted([], options.drawn)
    )
  )
}

/** Collects what the command printed, so a test can read what it said. */
const recording = (printed: Array<string>) => {
  const console_: Console.Console = Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
    error: () => {}
  })
  return Effect.provideService(Console.Console, console_)
}

const registered = (...repos: ReadonlyArray<string>) =>
  write({ repos: Object.fromEntries(repos.map((name) => [name, {}])) } satisfies ConfigFile)

const run = (...argv: ReadonlyArray<string>) => Command.runWith(dwMc, { version })(argv)

const runOf = (head_: string) =>
  Effect.flatMap(storeFor("runs", ReviewRun), (runs) => runs.get(runKey(repo, 28, head_)))

describe("dw-mc review", () => {
  it.effect("reviews the head in a throwaway worktree and keeps what it found", () => {
    const printed: Array<string> = []
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      yield* run("review", "28")

      const recorded = Option.getOrThrow(yield* runOf(head))
      assert.deepStrictEqual(
        { ...recorded, ranAt: undefined },
        {
          repo,
          number: 28,
          head,
          runner: "builtin",
          effort: "low",
          sessionId: session,
          ranAt: undefined
        }
      )

      const reports = yield* textStoreFor("runs")
      const document = yield* reports.get(reportKey(repo, 28, head))
      assert.include(document ?? "", `# ${repo}#28 ${title}`)
      assert.include(document ?? "", `- head: ${head}`)
      assert.include(document ?? "", report)

      assert.deepStrictEqual(printed, [
        `${repo}#28  ${title}`,
        `  head 284d599  builtin, effort low`,
        "  · Bash",
        "  · Agent",
        "",
        report,
        "",
        `Recorded against 284d599 in ${state}`
      ])
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("runs the review in the worktree and nowhere near my own checkout", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      yield* run("review", "28")

      assert.deepStrictEqual(spawned, [
        `gh pr view 28 --repo ${repo} --json number,title,url,isDraft,headRefOid,mergeable,reviewDecision,statusCheckRollup`,
        `git -C ${clone} rev-parse --is-bare-repository`,
        `git -C ${clone} fetch --no-tags --force origin refs/pull/28/head`,
        `git -C ${clone} rev-parse FETCH_HEAD`,
        `git -C ${clone} worktree remove --force ${worktree}`,
        `git -C ${clone} worktree add --detach ${worktree} ${head}`,
        `claude -p /code-review low --output-format stream-json --verbose`,
        `git -C ${clone} worktree remove --force ${worktree}`,
        `osascript -e display notification "${repo}#28 reviewed" with title "dw-mc review"`
      ])
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })

  it.effect("takes the effort from the flag, over the one the repository configured", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* write({ repos: { [repo]: { review: { effort: "medium" } } } })

      yield* run("review", "28", "--effort", "high")

      assert.include(spawned, "claude -p /code-review high --output-format stream-json --verbose")
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })

  it.effect("takes the configured effort when the flag says nothing", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* write({ repos: { [repo]: { review: { effort: "medium" } } } })

      yield* run("review", "28")

      assert.include(spawned, "claude -p /code-review medium --output-format stream-json --verbose")
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })

  it.effect("rings the terminal and puts the news on the desktop when it ends", () => {
    const spawned: Array<string> = []
    const drawn: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      yield* run("review", "28")

      assert.include(drawn, "\u0007")
      assert.isTrue(spawned.some((vector) => vector.startsWith("osascript ")))
    }).pipe(Effect.provide(machine({ spawned, drawn })), recording([]))
  })

  it.effect("takes the worktree down when the runner gives up, and records nothing", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      const error = yield* Effect.flip(run("review", "28"))

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "Invalid API key")
      assert.strictEqual(spawned.at(-1), `git -C ${clone} worktree remove --force ${worktree}`)
      assert.deepStrictEqual(yield* runOf(head), Option.none())
    }).pipe(
      Effect.provide(machine({ spawned, runner: { stderr: "Invalid API key · Run /login\n", exitCode: 1 } })),
      recording([])
    )
  })

  it.effect("takes the pull request out of Needs review run", () => {
    const printed: Array<string> = []
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      yield* run("status")
      assert.strictEqual(printed[0], "Needs review run")

      printed.length = 0
      yield* run("review", "28")

      printed.length = 0
      yield* run("status")
      assert.strictEqual(printed[0], "Ready")
    }).pipe(Effect.provide(machine({ spawned, repos: { [repo]: [28] } })), recording(printed))
  })

  it.effect("asks which repository when a number alone cannot say", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo, "dominikwozniak/dotfiles")

      const error = yield* Effect.flip(run("review", "28"))

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "2 repositories are registered")
      assert.include(error.message, "dominikwozniak/dotfiles#28")
      assert.deepStrictEqual(spawned, [])
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })

  it.effect("stops on a repository configured for a runner that is not built yet", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* write({ repos: { [repo]: { review: { runners: ["prompt"] } } } })

      const error = yield* Effect.flip(run("review", "28"))

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "prompt")
      assert.deepStrictEqual(spawned, [])
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })

  it.effect("says what it cannot read rather than guessing at it", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      const error = yield* Effect.flip(run("review", "the one about lint"))

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "the one about lint")
      assert.deepStrictEqual(spawned, [])
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })

  it.effect("reviews a pull request in a repository nothing registered", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* run("review", "someone/else#3")

      assert.include(spawned, "claude -p /code-review low --output-format stream-json --verbose")
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })
})
