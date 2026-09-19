import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Terminal } from "effect"

import type { ConfigFile } from "#adapters/config.ts"
import { write } from "#adapters/config.ts"
import { prViewOf } from "#adapters/gh.ts"
import { coloured, Paint } from "#adapters/paint.ts"
import { key, recording, typed } from "#adapters/picker.ts"
import { json, layerStubbed, refused, vectorOf } from "#adapters/spawner.ts"
import { storeFor } from "#adapters/store.ts"
import { machineOf, run } from "#cli/cli.ts"
import { picker } from "#cli/pick.ts"
import type { Finding } from "#domain/findings.ts"
import { LastReviewed, latestKey, ReviewRun, runKey } from "#domain/review.ts"
import { withdraw } from "#domain/stamp.ts"

const me = "dominikwozniak"
const repo = "dominikwozniak/dw-mc"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"

/** One tracked PR, in as much of `gh pr view --json` as the sweep reads. */
interface Fixture {
  readonly number: number
  readonly title?: string
  readonly mergeable?: string
  readonly reviewDecision?: string
}

const view = (pr: Fixture) =>
  prViewOf(repo, {
    number: pr.number,
    title: pr.title,
    headRefOid: head,
    mergeable: pr.mergeable,
    reviewDecision: pr.reviewDecision,
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "Check",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        workflowName: "Quality gate",
        detailsUrl: `https://github.com/${repo}/actions/runs/1/job/${pr.number}`
      }
    ]
  })

/** A `gh` that answers the reads a sweep makes, and dies on anything else. */
const github = (prs: ReadonlyArray<Fixture>, spawned: Array<string>) =>
  layerStubbed({
    onSpawn: (command) => spawned.push(vectorOf(command)),
    stubs: [
      (_, argv) => (argv === "api user" ? json({ login: me }) : undefined),
      (_, argv) =>
        argv.startsWith("search prs ")
          ? json(prs.map((pr) => ({ number: pr.number, repository: { nameWithOwner: repo } })))
          : undefined,
      (_, argv) => (argv.startsWith("repo view ") ? json({ defaultBranchRef: { name: "main" } }) : undefined),
      (_, argv) => {
        const detail = /^pr view (\d+) --repo \S+ --json (\S+)$/.exec(argv)
        if (detail === null) {
          return undefined
        }
        const [, number = "", fields = ""] = detail
        const pr = prs.find((each) => each.number === Number(number))
        if (pr === undefined) {
          return refused(`no pull request ${repo}#${number}`)
        }
        if (fields === "commits") {
          return json({ commits: [] })
        }
        if (fields === "files") {
          return json({ files: [] })
        }
        return json(view(pr))
      },
      (_, argv) => (/^api repos\/\S+\/(issues|pulls)\/\d+\/(comments|reviews)/.test(argv) ? json([]) : undefined)
    ]
  })

/** Everything the picker runs on: a fake `gh`, an in-memory config and state, and a scripted keyboard. */
const machine = (options: {
  readonly prs: ReadonlyArray<Fixture>
  readonly keys: ReadonlyArray<Terminal.UserInput>
  readonly spawned?: Array<string> | undefined
  readonly drawn?: Array<string> | undefined
  readonly columns?: number | undefined
}) =>
  machineOf({
    keys: options.keys,
    drawn: options.drawn,
    columns: options.columns,
    spawner: github(options.prs, options.spawned ?? [])
  })

const registered = (settings: ConfigFile["repos"] = { [repo]: {} }) => write({ repos: settings } satisfies ConfigFile)

/** What `dw-mc review` leaves behind: a review run against one head. */
const reviewed = Effect.fnUntraced(function* (number: number, findings: ReadonlyArray<Finding> = []) {
  const runs = yield* storeFor("runs", ReviewRun)
  const latest = yield* storeFor("runs", LastReviewed)
  yield* runs.set(runKey(repo, number, head), {
    repo,
    number,
    head,
    command: "/code-review",
    effort: "low",
    sessionId: "befb6186-5471-4b26-b680-e8ca49df25ac",
    ranAt: DateTime.makeUnsafe("2026-09-16T14:21:00Z"),
    outcome: { _tag: "reported", verdict: findings.length === 0 ? "clean" : "findings", findings }
  })
  yield* latest.set(latestKey(repo, number), { head })
})

/**
 * What the picker dispatched when I took the offer `at` places down the list,
 * without running the command it names.
 *
 * Every action is reached this way rather than by letting the command run,
 * because what is under test is the dispatch: a command that opens a session or
 * pushes a branch would be testing that command again instead.
 */
const dispatched = (at: number) => {
  const argv: Array<ReadonlyArray<string>> = []
  const keys = [key("enter"), ...Array.from({ length: at }, () => key("down")), key("enter")]
  return Effect.gen(function* () {
    yield* registered({ [repo]: { rebase: { enabled: true } } })
    yield* reviewed(1)
    yield* picker((args: ReadonlyArray<string>) => Effect.sync(() => argv.push(args)))()
    return argv
  }).pipe(Effect.provide(machine({ prs: [{ number: 1, reviewDecision: "APPROVED" }], keys })))
}

/** The last frame a prompt drew, which is the one I answered. */
const frame = (drawn: ReadonlyArray<string>) => drawn.join("\n")

describe("dw-mc with no arguments", () => {
  it.effect("lists every tracked PR under the bucket it sits in", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* run()

      const rows = frame(drawn)
      assert.include(rows, "● Needs me         │ dominikwozniak/dw-mc#2")
      assert.include(rows, "◐ Needs review run │ dominikwozniak/dw-mc#1")
      assert.include(rows, "merge conflict")
    }).pipe(
      Effect.provide(
        machine({
          prs: [
            { number: 1, title: "feat: a first one" },
            { number: 2, title: "feat: conflicted", mergeable: "CONFLICTING" }
          ],
          keys: [],
          drawn
        })
      ),
      recording(printed)
    )
  })

  it.effect("leaves the link off its rows, which pay for every character they draw", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* run()

      const rows = frame(drawn)
      assert.include(rows, "dominikwozniak/dw-mc#1", "the pull request is still how I know which row I am on")
      assert.notInclude(rows, "https://github.com", "and the URL under it would cost the title the room it needs")
    }).pipe(
      Effect.provide(machine({ prs: [{ number: 1, title: "feat: a first one" }], keys: [], drawn })),
      Effect.provideService(Paint, coloured),
      recording(printed)
    )
  })

  it.effect("says what the keyboard does, where the hint leaves with the prompt", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* run()

      assert.include(frame(drawn), "↑↓ move · enter choose · q quit")
      assert.isFalse(
        printed.some((line) => line.includes("↑↓")),
        "the hint is the prompt's, so it is not left behind on the screen"
      )
    }).pipe(
      Effect.provide(machine({ prs: [{ number: 1, title: "feat: a first one" }], keys: [], drawn })),
      recording(printed)
    )
  })

  it.effect("drops the title's column before it cuts what a PR waits on", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* run()

      const rows = frame(drawn)
      assert.include(rows, "merge conflict", "the reason is why I am reading the list, so it stays whole")
      assert.notInclude(rows, "feat: conflicted", "and the title is what gives way")
    }).pipe(
      Effect.provide(
        machine({
          prs: [{ number: 2, title: "feat: conflicted", mergeable: "CONFLICTING" }],
          keys: [],
          drawn,
          columns: 60
        })
      ),
      recording(printed)
    )
  })

  it.effect("sweeps before it lists, so the list is never one I forgot to refresh", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* run()

      assert.isTrue(spawned.some((each) => each.startsWith("gh search prs ")))
    }).pipe(Effect.provide(machine({ prs: [{ number: 1 }], keys: [], spawned })), recording(printed))
  })

  it.effect("offers the actions the pull request has something to act on", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* reviewed(1)
      yield* run()

      const offers = frame(drawn)
      assert.include(offers, "What do I do with dominikwozniak/dw-mc#1?")
      assert.include(offers, "Show the review-run report")
      assert.include(offers, "Open a fix session on the findings")
      assert.notInclude(offers, "Rebase onto the base")
    }).pipe(Effect.provide(machine({ prs: [{ number: 1 }], keys: [key("enter")], drawn })), recording(printed))
  })

  it.effect("offers only a review where no run has covered this head", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* run()

      const offers = frame(drawn)
      assert.include(offers, "Run a review")
      assert.notInclude(offers, "Show the review-run report")
    }).pipe(Effect.provide(machine({ prs: [{ number: 1 }], keys: [key("enter")], drawn })), recording(printed))
  })

  it.effect("shows the review-run report of the pull request I picked", () => {
    const printed: Array<string> = []
    const keys = [key("enter"), key("down"), key("enter")]

    return Effect.gen(function* () {
      yield* registered()
      yield* reviewed(1, [
        { file: "src/cli/review.ts", line: 88, severity: "error", summary: "The run is never recorded." }
      ])
      yield* run()

      assert.include(printed.join("\n"), "The run is never recorded.")
    }).pipe(Effect.provide(machine({ prs: [{ number: 1 }], keys })), recording(printed))
  })

  it.effect("withdraws the stamp through the stamp command's own flag", () => {
    const printed: Array<string> = []
    // Past the review, the report and the fix session, to the last offer.
    const keys = [key("enter"), key("down"), key("down"), key("down"), key("enter")]

    return Effect.gen(function* () {
      yield* registered()
      yield* reviewed(1)
      yield* run()

      assert.include(printed.join("\n"), "stamp withdrawn, until the head changes")
    }).pipe(Effect.provide(machine({ prs: [{ number: 1, reviewDecision: "APPROVED" }], keys })), recording(printed))
  })

  it.effect("offers a rebase where the repository turned rebase on", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered({ [repo]: { rebase: { enabled: true } } })
      yield* run()

      assert.include(frame(drawn), "Rebase onto the base and push")
    }).pipe(Effect.provide(machine({ prs: [{ number: 1 }], keys: [key("enter")], drawn })), recording(printed))
  })

  it.effect("dispatches every offer into the command it names", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* dispatched(0), [["review", "dominikwozniak/dw-mc#1"]])
      assert.deepStrictEqual(yield* dispatched(1), [["findings", "dominikwozniak/dw-mc#1"]])
      assert.deepStrictEqual(yield* dispatched(2), [["fix", "dominikwozniak/dw-mc#1"]])
      assert.deepStrictEqual(yield* dispatched(3), [["rebase", "dominikwozniak/dw-mc#1"]])
      assert.deepStrictEqual(yield* dispatched(4), [["stamp", "dominikwozniak/dw-mc#1", "--withdraw"]])
    })
  )

  it.effect("dispatches nothing where I walk away from the pull request", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* run()

      assert.deepStrictEqual(printed, [])
    }).pipe(Effect.provide(machine({ prs: [{ number: 1 }], keys: [] })), recording(printed))
  })

  it.effect("says where to start when no repository is registered", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* run()

      assert.deepStrictEqual(printed, [
        "No repositories registered. Run dw-mc init inside a repository to register it."
      ])
    }).pipe(Effect.provide(machine({ prs: [], keys: [] })), recording(printed))
  })

  it.effect("says so when there is nothing open to pick", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* run()

      assert.deepStrictEqual(printed, ["No open pull requests."])
    }).pipe(Effect.provide(machine({ prs: [], keys: [] })), recording(printed))
  })
})

/**
 * The one offer that cannot be taken back, and the question standing in front
 * of it (ADR 0008).
 */
describe("the picker's merge", () => {
  /** Down to the merge offer, which is the last one a Ready, stamped PR carries. */
  const toMerge = [key("enter"), ...Array.from({ length: 5 }, () => key("down")), key("enter")]

  /** What the picker dispatched after I answered the confirmation with `answer`. */
  const answering = (answer: ReadonlyArray<Terminal.UserInput>, printed: Array<string>) => {
    const argv: Array<ReadonlyArray<string>> = []
    return Effect.gen(function* () {
      yield* registered({ [repo]: { rebase: { enabled: true } } })
      yield* reviewed(1)
      yield* picker((args: ReadonlyArray<string>) => Effect.sync(() => argv.push(args)))()
      return argv
    }).pipe(
      Effect.provide(machine({ prs: [{ number: 1, reviewDecision: "APPROVED" }], keys: [...toMerge, ...answer] })),
      recording(printed)
    )
  }

  it.effect("offers it on a Ready, stamped pull request, and offers it last", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* reviewed(1)
      yield* run()

      const offers = frame(drawn)
      assert.include(offers, "Squash-merge it and delete the branch")
      assert.isAbove(
        offers.indexOf("Squash-merge it"),
        offers.indexOf("Withdraw the stamp"),
        "the cursor rests on the first row, and this is the offer no reflog undoes"
      )
    }).pipe(
      Effect.provide(machine({ prs: [{ number: 1, reviewDecision: "APPROVED" }], keys: [key("enter")], drawn })),
      recording(printed)
    )
  })

  it.effect("offers nothing to merge where the pull request is not Ready", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* reviewed(1)
      yield* run()

      assert.notInclude(frame(drawn), "Squash-merge")
    }).pipe(
      Effect.provide(machine({ prs: [{ number: 1, reviewDecision: "REVIEW_REQUIRED" }], keys: [key("enter")], drawn })),
      recording(printed)
    )
  })

  it.effect("offers nothing to merge where nothing stamps it", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* reviewed(1)
      yield* withdraw(repo, 1, head)
      yield* run()

      assert.notInclude(frame(drawn), "Squash-merge")
    }).pipe(
      Effect.provide(machine({ prs: [{ number: 1, reviewDecision: "APPROVED" }], keys: [key("enter")], drawn })),
      recording(printed)
    )
  })

  it.effect("dispatches it once I have answered the question it carries", () =>
    Effect.gen(function* () {
      const printed: Array<string> = []

      assert.deepStrictEqual(yield* answering(typed("y"), printed), [["merge", "dominikwozniak/dw-mc#1"]])
    })
  )

  it.effect("dispatches nothing where I answer it with anything else", () =>
    Effect.gen(function* () {
      const printed: Array<string> = []
      // Enter is the answer the prompt starts on, and it starts on no: the one
      // keystroke too many must not merge a pull request and delete its branch.
      assert.deepStrictEqual(yield* answering([key("enter")], printed), [])
      assert.include(printed.join("\n"), "Nothing done to dominikwozniak/dw-mc#1.")

      const walked: Array<string> = []
      assert.deepStrictEqual(yield* answering([], walked), [])
    })
  )
})

/** The stamp the picker offers to withdraw is the one a sweep computed. */
describe("the picker's stamp", () => {
  it.effect("offers no withdrawal where the stamp is already off", () => {
    const drawn: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* reviewed(1)
      yield* withdraw(repo, 1, head)
      yield* run()

      assert.notInclude(frame(drawn), "Withdraw the stamp")
    }).pipe(
      Effect.provide(machine({ prs: [{ number: 1, reviewDecision: "APPROVED" }], keys: [key("enter")], drawn })),
      recording(printed)
    )
  })
})

describe("what moved since I last looked, in the picker", () => {
  it.effect("marks a pull request it has never shown", () => {
    const drawn: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* run()

      assert.include(frame(drawn), "+ ◐ Needs review run │ dominikwozniak/dw-mc#1")
    }).pipe(Effect.provide(machine({ prs: [{ number: 1 }], keys: [], drawn })), recording([]))
  })

  it.effect("counts as having shown me the rows, even where I pick none of them", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered()
      yield* run()
      // --all, because the picker covers every registered repository wherever I stand.
      yield* run("status", "--all")

      assert.deepStrictEqual(printed, [
        "Needs review run",
        `  ◐ ${repo}#1 │ feat: seen in the picker │ no review run on this head`
      ])
    }).pipe(
      Effect.provide(machine({ prs: [{ number: 1, title: "feat: seen in the picker" }], keys: [] })),
      recording(printed)
    )
  })
})
