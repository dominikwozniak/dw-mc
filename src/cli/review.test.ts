import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Option } from "effect"

import type { ConfigFile } from "#adapters/config.ts"
import { builtInLauncher, write } from "#adapters/config.ts"
import { recording } from "#adapters/picker.ts"
import { prViewOf, viewFields } from "#adapters/pr.ts"
import { fakeHandle, json, layerStubbed, refused, vectorOf, wrote } from "#adapters/spawner.ts"
import { storeFor, textStoreFor } from "#adapters/store.ts"
import { machineOf, run } from "#cli/cli.ts"
import type { Finding } from "#domain/findings.ts"
import type { Outcome } from "#domain/review.ts"
import { LastReviewed, latestKey, reportKey, ReviewRun, runKey } from "#domain/review.ts"

const me = "dominikwozniak"
/** The program a run is spawned as, which the launcher names and the default spells `claude`. */
const launching = builtInLauncher.command[0]

const repo = "dominikwozniak/dw-mc"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"
const before = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"
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

/** What the second turn validated, one finding graded in the persona's own word. */
const structured = {
  verdict: "findings",
  findings: [
    { file: "src/cli/review.ts", line: 88, severity: "error", summary: "The run is never recorded." },
    { file: "docs/v1-design.md", line: 3, severity: "Nit", summary: "The build order is out of date." }
  ]
}

/** The findings as they are kept once a persona's word has been weighed in ours. */
const weighed: ReadonlyArray<Finding> = [
  { file: "src/cli/review.ts", line: 88, severity: "error", summary: "The run is never recorded." },
  { file: "docs/v1-design.md", line: 3, severity: "info", summary: "The build order is out of date." }
]

/** What a promptless run's one turn prints: the prose it wrote, then the findings it validated. */
const answered = (fields: Record<string, unknown>) =>
  [
    { type: "system", subtype: "init", session_id: session },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: report }] } },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: session,
      structured_output: structured,
      result: JSON.stringify(structured),
      num_turns: 1,
      ...fields
    }
  ]
    .map((event) => JSON.stringify(event))
    .join("\n")

/** The one object `claude --output-format json --json-schema` prints. */
const reported = (fields: Record<string, unknown>) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: session,
    result: JSON.stringify(structured),
    num_turns: 2,
    ...fields
  })

/** What one turn of `claude` prints, and what it exits with. */
interface Turn {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
}

/**
 * Every program a review run spawns, from fixtures, and a death for anything
 * else - which is what keeps the run's reach over my machine honest.
 */
const machine = (options: {
  readonly spawned: Array<string>
  readonly drawn?: Array<string> | undefined
  /** How wide the screen is. Zero is a pipe, where the run writes lines instead.  */
  readonly columns?: number | undefined
  /** The first turn of a review run on a slash command, which writes the report. */
  readonly review?: Turn | undefined
  /** The second turn, which reports the findings. */
  readonly findings?: Turn | undefined
  /** The one turn a review with no slash command takes. */
  readonly prompt?: Turn | undefined
  /** The pull requests `gh` knows about, by repository. */
  readonly repos?: Record<string, ReadonlyArray<number>> | undefined
  /** What GitHub says changed since the head a previous run was recorded against. */
  readonly changed?: ReadonlyArray<string> | undefined
  /** Who opened the pull request, where it is not me. */
  readonly author?: string | undefined
}) => {
  const turn = (fixture: Turn | undefined, stdout: string) =>
    Effect.succeed(
      fakeHandle({ stdout: fixture?.stdout ?? stdout, stderr: fixture?.stderr, exitCode: fixture?.exitCode })
    )

  return machineOf({
    drawn: options.drawn,
    columns: options.columns,
    spawner: layerStubbed({
      onSpawn: (command) => options.spawned.push(vectorOf(command)),
      stubs: [
        (command) => {
          if (command.command !== launching) {
            return undefined
          }
          if (command.args.includes("--resume")) {
            return turn(options.findings, reported({ structured_output: structured }))
          }
          // A turn held to a schema is the whole review; a turn without one opens on
          // a slash command, and its findings come on the turn that resumes it. That
          // is the constraint itself, rather than which command the prompt names.
          return command.args.includes("--json-schema")
            ? turn(options.prompt, answered({}))
            : turn(options.review, finished)
        },
        (command) => (command.command === "osascript" ? wrote("") : undefined),
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
          return wrote("")
        },
        (_, argv) => (argv === "api user" ? json({ login: me }) : undefined),
        // `dw-mc status` runs from outside any repository, so it covers every registered one.
        (_, argv) => (argv === "repo view --json nameWithOwner" ? refused("fatal: not a git repository") : undefined),
        (_, argv) => {
          const search = /^search prs .* --repo (\S+) /.exec(argv)
          const named = search?.[1] ?? ""
          return search === null
            ? undefined
            : json((options.repos?.[named] ?? []).map((number) => ({ number, repository: { nameWithOwner: named } })))
        },
        (_, argv) => {
          const detail = /^pr view (\d+) --repo (\S+) --json (\S+)$/.exec(argv)
          if (detail === null) {
            return undefined
          }
          const [, number = "", named = "", fields = ""] = detail
          return fields === "commits"
            ? json({ commits: [] })
            : json(
                prViewOf(named, {
                  number: Number(number),
                  title,
                  author: options.author,
                  headRefOid: head,
                  headRefName: "feat/28-a-branch",
                  reviewDecision: "APPROVED",
                  statusCheckRollup: [{ name: "Check", status: "COMPLETED", conclusion: "SUCCESS" }]
                })
              )
        },
        (_, argv) =>
          /^api repos\/\S+\/compare\/\S+$/.test(argv)
            ? options.changed === undefined
              ? refused("gh: No commit found for SHA\n")
              : json({ files: options.changed.map((filename) => ({ filename })) })
            : undefined,
        (_, argv) =>
          /^api repos\/\S+\/(issues|pulls)\/\d+\/(comments|reviews)\?per_page=100$/.test(argv) ? json([]) : undefined,
        (_, argv) => (/^api repos\/\S+?\/\S+?\/labels\/\S+$/.test(argv) ? json({ name: "defined" }) : undefined),
        (_, argv) => (/^api -X POST repos\/\S+\/issues\/\d+\/labels -f /.test(argv) ? json([]) : undefined)
      ]
    })
  })
}

const registered = (...repos: ReadonlyArray<string>) =>
  write({ repos: Object.fromEntries(repos.map((name) => [name, {}])) } satisfies ConfigFile)

const runOf = (head_: string) =>
  Effect.flatMap(storeFor("runs", ReviewRun), (runs) => runs.get(runKey(repo, 28, head_)))

/** A review run this head has already had, as a previous command would have left it. */
const already = Effect.fnUntraced(function* (at: string, outcome: Outcome) {
  const runs = yield* storeFor("runs", ReviewRun)
  const latest = yield* storeFor("runs", LastReviewed)
  yield* runs.set(runKey(repo, 28, at), {
    repo,
    number: 28,
    head: at,
    command: "/code-review",
    effort: "low",
    sessionId: session,
    ranAt: DateTime.makeUnsafe("2026-09-15T10:00:00Z"),
    outcome
  })
  yield* latest.set(latestKey(repo, 28), { head: at })
})

const clean: Outcome = { _tag: "reported", verdict: "clean", findings: [] }

const reviewed = (spawned: ReadonlyArray<string>) =>
  spawned.some((vector) => vector.startsWith("claude -p /code-review"))

describe("dw-mc review", () => {
  it.effect("reviews the head in a throwaway worktree and keeps what both turns found", () => {
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
          command: "/code-review",
          effort: "low",
          sessionId: session,
          ranAt: undefined,
          outcome: { _tag: "reported", verdict: "findings", findings: weighed }
        }
      )

      const reports = yield* textStoreFor("runs")
      const document = yield* reports.get(reportKey(repo, 28, head))
      assert.include(document ?? "", `# ${repo}#28 ${title}`)
      assert.include(document ?? "", `- head: ${head}`)
      assert.include(document ?? "", report)

      assert.deepStrictEqual(printed, [
        `${repo}#28  ${title}`,
        `  head 284d599  /code-review low`,
        "",
        report,
        "",
        "2 findings, 1 blocking",
        "  src/cli/review.ts:88 │ error │ The run is never recorded.",
        "  docs/v1-design.md:3  │ info  │ The build order is out of date.",
        "",
        `Recorded against 284d599 in ${state}`
      ])
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("says what the run is reaching for: on a screen in place, in a pipe a line at a time", () => {
    const spawned: Array<string> = []
    const drawn: Array<string> = []
    const printed: Array<string> = []
    const piped: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* run("review", "28")

      assert.include(drawn.join("\n"), "reviewing · ")
      assert.isFalse(printed.some((line) => line.includes("· Bash")))
    }).pipe(
      Effect.provide(machine({ spawned, drawn })),
      recording(printed),
      Effect.andThen(
        Effect.gen(function* () {
          yield* registered(repo)
          yield* run("review", "28")

          assert.include(piped, "  · Bash")
          assert.include(piped, "  · Agent")
        }).pipe(Effect.provide(machine({ spawned: [], columns: 0 })), recording(piped))
      )
    )
  })

  it.effect("runs both turns in the worktree and nowhere near my own checkout", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      yield* Effect.ignore(run("review", "28"))

      assert.deepStrictEqual(spawned, [
        `gh pr view 28 --repo ${repo} --json ${viewFields}`,
        `git -C ${clone} rev-parse --is-bare-repository`,
        `git -C ${clone} fetch --no-tags --force origin +refs/pull/28/head:refs/dw-mc/pr/28 +refs/heads/*:refs/heads/*`,
        `git -C ${clone} rev-parse refs/dw-mc/pr/28`,
        `git -C ${clone} worktree remove --force ${worktree}`,
        `git -C ${clone} worktree add --detach ${worktree} ${head}`,
        `claude -p /code-review low --output-format stream-json --verbose`,
        spawned[7] ?? "",
        `git -C ${clone} worktree remove --force ${worktree}`,
        `osascript -e display notification "${repo}#28 reviewed" with title "dw-mc review"`
      ])
      assert.include(spawned[7] ?? "", `claude -p --resume ${session}`)
      assert.include(spawned[7] ?? "", "--output-format json --json-schema")
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })

  it.effect("holds the second turn to the schema the findings are kept under", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      yield* Effect.ignore(run("review", "28"))

      const handed = /--json-schema (.+)$/.exec(spawned[7] ?? "")?.[1] ?? ""

      // The document itself is `#domain/findings.ts`'s to get right, and its own
      // test holds it. What this holds is that the document reaching the run
      // is that one: the severities the tool will accept, asked for by name.
      assert.include(handed, `"severity":{"type":"string","enum":["error","warning","info"]}`)
      assert.include(handed, `"required":["verdict","findings"]`)
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })

  it.effect("takes the effort from the flag, over the one the repository configured", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* write({ repos: { [repo]: { review: { effort: "medium" } } } })

      yield* Effect.ignore(run("review", "28", "--effort", "high"))

      assert.include(spawned, "claude -p /code-review high --output-format stream-json --verbose")
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })

  it.effect("takes the configured effort when the flag says nothing", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* write({ repos: { [repo]: { review: { effort: "medium" } } } })

      yield* Effect.ignore(run("review", "28"))

      assert.include(spawned, "claude -p /code-review medium --output-format stream-json --verbose")
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })

  it.effect("rings the terminal and puts the news on the desktop when it ends", () => {
    const spawned: Array<string> = []
    const drawn: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      yield* Effect.ignore(run("review", "28"))

      assert.include(drawn, "")
      assert.isTrue(spawned.some((vector) => vector.startsWith("osascript ")))
    }).pipe(Effect.provide(machine({ spawned, drawn })), recording([]))
  })

  it.effect("takes the worktree down when the run gives up, and records the failure", () => {
    const spawned: Array<string> = []
    const drawn: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      const error = yield* Effect.flip(run("review", "28"))

      assert.strictEqual(error._tag, "UserError")
      assert.include(error.message, "Invalid API key")
      assert.include(spawned, `git -C ${clone} worktree remove --force ${worktree}`)
      // A run that would not start is recorded as the failure it is, never as
      // a clean verdict and never as nothing at all.
      const recorded = Option.getOrThrow(yield* runOf(head))
      assert.strictEqual(recorded.outcome._tag, "failed")
      assert.strictEqual(recorded.sessionId, null)
      // The run I walked away from is the one I most need to hear give up.
      assert.include(drawn, "")
      assert.include(spawned.at(-1) ?? "", `${repo}#28 could not be reviewed`)
    }).pipe(
      Effect.provide(machine({ spawned, drawn, review: { stderr: "Invalid API key · Run /login\n", exitCode: 1 } })),
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
      yield* Effect.ignore(run("review", "28"))

      printed.length = 0
      yield* run("status")
      // The run reported a blocking finding, which is the next thing the pull
      // request waits on me for.
      assert.strictEqual(printed[0], "Needs me")
      assert.include(printed[1] ?? "", "1 blocking finding")
    }).pipe(Effect.provide(machine({ spawned, repos: { [repo]: [28] } })), recording(printed))
  })

  it.effect("leaves a pull request whose findings are all advisory out of Needs me", () => {
    const printed: Array<string> = []
    const spawned: Array<string> = []
    const advisory = { verdict: "findings", findings: [structured.findings[1]] }

    return Effect.gen(function* () {
      yield* registered(repo)

      yield* run("review", "28")

      printed.length = 0
      yield* run("status")
      assert.strictEqual(printed[0], "Ready")
    }).pipe(
      Effect.provide(
        machine({
          spawned,
          repos: { [repo]: [28] },
          findings: { stdout: reported({ structured_output: advisory, result: JSON.stringify(advisory) }) }
        })
      ),
      recording(printed)
    )
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
      yield* Effect.ignore(run("review", "someone/else#3"))

      assert.include(spawned, "claude -p /code-review low --output-format stream-json --verbose")
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })
})

describe("dw-mc review, and what a run costs twice", () => {
  it.effect("skips a run where only documentation changed since the last one", () => {
    const printed: Array<string> = []
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* already(before, clean)

      yield* run("review", "28")

      assert.isFalse(reviewed(spawned))
      assert.include(printed.at(-1) ?? "", "only documentation changed since 1a2b3c4")
      assert.include(spawned, `gh api repos/${repo}/compare/${before}...${head}`)
    }).pipe(
      Effect.provide(machine({ spawned, changed: ["README.md", "docs/adr/0006-source-layout.md"] })),
      recording(printed)
    )
  })

  it.effect("runs where anything outside those globs changed", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* already(before, clean)

      yield* Effect.ignore(run("review", "28"))

      assert.isTrue(reviewed(spawned))
    }).pipe(Effect.provide(machine({ spawned, changed: ["README.md", "src/cli/review.ts"] })), recording([]))
  })

  it.effect("runs regardless when I force it", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* already(before, clean)

      yield* Effect.ignore(run("review", "28", "--force"))

      assert.isTrue(reviewed(spawned))
      assert.isFalse(spawned.some((vector) => vector.includes("/compare/")))
    }).pipe(Effect.provide(machine({ spawned, changed: ["README.md"] })), recording([]))
  })

  it.effect("skips a second run against a head that has already had one", () => {
    const printed: Array<string> = []
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* already(head, clean)

      yield* run("review", "28")

      assert.isFalse(reviewed(spawned))
      // Nothing changed, so nothing is asked of GitHub either.
      assert.isFalse(spawned.some((vector) => vector.includes("/compare/")))
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("never skips over a run that reported nothing", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* already(before, { _tag: "failed", detail: "the findings turn came back with no structured output" })

      yield* Effect.ignore(run("review", "28"))

      assert.isTrue(reviewed(spawned))
    }).pipe(Effect.provide(machine({ spawned, changed: ["README.md"] })), recording([]))
  })

  it.effect("never skips a run GitHub could not say anything about", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* already(before, clean)

      yield* Effect.ignore(run("review", "28"))

      assert.isTrue(reviewed(spawned))
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })
})

describe("dw-mc review, and a second turn that does not report", () => {
  const failing = (findings: Turn) =>
    Effect.gen(function* () {
      yield* registered(repo)

      const error = yield* Effect.flip(run("review", "28"))
      assert.strictEqual(error._tag, "UserError")

      return Option.getOrThrow(yield* runOf(head)).outcome
    }).pipe(Effect.provide(machine({ spawned: [], findings })), recording([]))

  it.effect("records a turn that exited non-zero as a failure", () =>
    Effect.gen(function* () {
      const outcome = yield* failing({ stderr: "No conversation found\n", exitCode: 1 })

      assert.strictEqual(outcome._tag, "failed")
      assert.include(outcome._tag === "failed" ? outcome.detail : "", "No conversation found")
    })
  )

  it.effect("records a turn that validated nothing as a failure", () =>
    Effect.gen(function* () {
      const outcome = yield* failing({ stdout: reported({}) })

      assert.strictEqual(outcome._tag, "failed")
      assert.include(outcome._tag === "failed" ? outcome.detail : "", "no structured output")
    })
  )

  it.effect("records findings that do not validate as a failure", () =>
    Effect.gen(function* () {
      const outcome = yield* failing({
        stdout: reported({
          structured_output: {
            verdict: "findings",
            findings: [{ file: "a.ts", line: 1, severity: "blocker", summary: "Nothing weighs this." }]
          }
        })
      })

      assert.strictEqual(outcome._tag, "failed")
      assert.include(outcome._tag === "failed" ? outcome.detail : "", "severity")
    })
  )

  it.effect("says a run reported nothing under the head it ran on, and still says where it was recorded", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* Effect.ignore(run("review", "28"))

      const failed = printed.findIndex((line) => line.startsWith("  reported nothing: "))
      assert.isAbove(failed, 0)
      assert.include(printed[failed] ?? "", "No conversation found")
      assert.deepStrictEqual(printed.slice(failed - 1, failed), [""])
      assert.deepStrictEqual(printed.slice(failed + 1), ["", `Recorded against 284d599 in ${state}`])
    }).pipe(
      Effect.provide(machine({ spawned: [], findings: { stderr: "No conversation found\n", exitCode: 1 } })),
      recording(printed)
    )
  })

  it.effect("keeps the report of a run whose findings failed, and still needs a review run", () => {
    const printed: Array<string> = []
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      yield* Effect.ignore(run("review", "28"))

      const reports = yield* textStoreFor("runs")
      assert.include((yield* reports.get(reportKey(repo, 28, head))) ?? "", report)

      printed.length = 0
      yield* run("status")
      assert.strictEqual(printed[0], "Needs review run")
    }).pipe(
      Effect.provide(
        machine({ spawned, repos: { [repo]: [28] }, findings: { stderr: "No conversation found\n", exitCode: 1 } })
      ),
      recording(printed)
    )
  })
})

describe("dw-mc review, with no slash command", () => {
  const promptOf = (spawned: ReadonlyArray<string>) =>
    spawned.find((vector) => vector.startsWith("claude -p You are an experienced")) ?? ""

  it.effect("runs the tool's own prompt in one turn and keeps what it validated", () => {
    const printed: Array<string> = []
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* write({ repos: { [repo]: { review: { command: null } } } })

      yield* run("review", "28")

      const recorded = Option.getOrThrow(yield* runOf(head))
      assert.strictEqual(recorded.command, null)
      assert.deepStrictEqual(recorded.outcome, { _tag: "reported", verdict: "findings", findings: weighed })
      // One turn, so nothing resumes anything.
      assert.isFalse(spawned.some((vector) => vector.includes("--resume")))
      assert.include(printed, "  head 284d599  the tool's own prompt")
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("holds that turn to the same schema the findings are kept under", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* write({ repos: { [repo]: { review: { command: null } } } })

      yield* run("review", "28")

      const handed = /--json-schema (.+)$/.exec(promptOf(spawned))?.[1] ?? ""
      assert.include(handed, `"severity":{"type":"string","enum":["error","warning","info"]}`)
      assert.include(handed, `"required":["verdict","findings"]`)
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })

  it.effect("tells the run which change it is reviewing and what against", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* write({ repos: { [repo]: { review: { command: null } } } })

      yield* run("review", "28")

      assert.include(promptOf(spawned), `${repo}#28, "${title}"`)
      assert.include(promptOf(spawned), "git diff main...HEAD")
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })

  it.effect("runs the prompt on the model configured, and puts my own instructions in front of it", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* write({
        repos: { [repo]: { review: { command: null, model: "claude-opus-5", prompt: "/house-review" } } }
      })

      yield* run("review", "28")

      const argv = spawned.find((vector) => vector.startsWith("claude -p /house-review")) ?? ""
      assert.include(argv, "--model claude-opus-5")
      assert.include(argv, "You are an experienced staff engineer")
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })

  it.effect("records a prompt run whose findings do not validate as a failure", () => {
    const spawned: Array<string> = []
    const wrong = answered({
      structured_output: {
        verdict: "findings",
        findings: [{ file: "a.ts", line: 1, severity: "blocker", summary: "Nothing weighs this." }]
      }
    })

    return Effect.gen(function* () {
      yield* write({ repos: { [repo]: { review: { command: null } } } })

      const error = yield* Effect.flip(run("review", "28"))

      assert.strictEqual(error._tag, "UserError")
      const recorded = Option.getOrThrow(yield* runOf(head))
      assert.strictEqual(recorded.outcome._tag, "failed")
      assert.include(recorded.outcome._tag === "failed" ? recorded.outcome.detail : "", "severity")
    }).pipe(Effect.provide(machine({ spawned, prompt: { stdout: wrong } })), recording([]))
  })
})

describe("dw-mc review, on a repository that labels", () => {
  const labelling = write({ repos: { [repo]: { labels: { enabled: true } } } })

  it.effect("puts the verdict it just recorded on my own pull request", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* labelling
      yield* run("review", "28")

      assert.deepStrictEqual(
        spawned.filter((argv) => argv.startsWith("gh api -X")),
        [`gh api -X POST repos/${repo}/issues/28/labels -f labels[]=review: changes`]
      )
    }).pipe(Effect.provide(machine({ spawned })), recording([]))
  })

  it.effect("leaves somebody else's pull request alone", () => {
    const spawned: Array<string> = []

    return Effect.gen(function* () {
      yield* labelling
      yield* run("review", "28")

      assert.isTrue(reviewed(spawned))
      assert.deepStrictEqual(
        spawned.filter((argv) => argv.startsWith("gh api -X")),
        []
      )
    }).pipe(Effect.provide(machine({ spawned, author: "someone" })), recording([]))
  })
})
