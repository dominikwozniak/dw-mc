import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Console, DateTime, Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect"
import { Command } from "effect/unstable/cli"

import type { ConfigFile } from "#adapters/config.ts"
import { ConfigStore, write } from "#adapters/config.ts"
import { key, layerScripted } from "#adapters/picker.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"
import * as Store from "#adapters/store.ts"
import { storeFor } from "#adapters/store.ts"
import { dwMc, version } from "#cli/cli.ts"
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

const view = (pr: Fixture) => ({
  number: pr.number,
  title: pr.title ?? "feat: a pull request",
  url: `https://github.com/${repo}/pull/${pr.number}`,
  isDraft: false,
  headRefOid: head,
  headRefName: `feat/${pr.number}-a-branch`,
  baseRefName: "main",
  author: { login: me },
  isCrossRepository: false,
  mergeable: pr.mergeable ?? "MERGEABLE",
  reviewDecision: pr.reviewDecision ?? "",
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
  layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("pick.test: the fake was handed a piped command")
    }
    const argv = command.args.join(" ")
    spawned.push(`${command.command} ${argv}`)
    const json = (value: unknown) => Effect.succeed(fakeHandle({ stdout: JSON.stringify(value) }))

    if (argv === "api user") {
      return json({ login: me })
    }
    if (argv.startsWith("search prs ")) {
      return json(prs.map((pr) => ({ number: pr.number, repository: { nameWithOwner: repo } })))
    }
    if (argv.startsWith("repo view ")) {
      return json({ defaultBranchRef: { name: "main" } })
    }

    const detail = /^pr view (\d+) --repo \S+ --json (\S+)$/.exec(argv)
    if (detail !== null) {
      const [, number = "", fields = ""] = detail
      const pr = prs.find((each) => each.number === Number(number))
      if (pr === undefined) {
        return Effect.succeed(fakeHandle({ exitCode: 1, stderr: `no pull request ${repo}#${number}` }))
      }
      if (fields === "commits") {
        return json({ commits: [] })
      }
      if (fields === "files") {
        return json({ files: [] })
      }
      return json(view(pr))
    }
    if (/^api repos\/\S+\/(issues|pulls)\/\d+\/(comments|reviews)/.test(argv)) {
      return json([])
    }

    return Effect.die(`pick.test: nothing stubbed for '${command.command} ${argv}'`)
  })

/** Everything the picker runs on: a fake `gh`, an in-memory config and state, and a scripted keyboard. */
const machine = (options: {
  readonly prs: ReadonlyArray<Fixture>
  readonly keys: ReadonlyArray<Terminal.UserInput>
  readonly spawned?: Array<string> | undefined
  readonly drawn?: Array<string> | undefined
}) =>
  Layer.provideMerge(
    Layer.mergeAll(ConfigStore.layerTest, Store.layerTest),
    Layer.mergeAll(
      ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/home/dw" })),
      FileSystem.layerNoop({}),
      Path.layer,
      Stdio.layerTest({}),
      github(options.prs, options.spawned ?? []),
      layerScripted(options.keys, options.drawn)
    )
  )

/** Collects what the picker and the command it dispatched printed. */
const recording = (printed: Array<string>) => {
  const console_: Console.Console = Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
    error: () => {}
  })
  return Effect.provideService(Console.Console, console_)
}

const registered = (settings: ConfigFile["repos"] = { [repo]: {} }) => write({ repos: settings } satisfies ConfigFile)

/** What `dw-mc review` leaves behind: a review run against one head. */
const reviewed = (number: number, findings: ReadonlyArray<Finding> = []) =>
  Effect.gen(function* () {
    const runs = yield* storeFor("runs", ReviewRun)
    const latest = yield* storeFor("runs", LastReviewed)
    yield* runs.set(runKey(repo, number, head), {
      repo,
      number,
      head,
      runner: "builtin",
      effort: "low",
      sessionId: "befb6186-5471-4b26-b680-e8ca49df25ac",
      ranAt: DateTime.makeUnsafe("2026-09-16T14:21:00Z"),
      outcome: { _tag: "reported", verdict: findings.length === 0 ? "clean" : "findings", findings }
    })
    yield* latest.set(latestKey(repo, number), { head })
  })

const run = (...argv: ReadonlyArray<string>) => Command.runWith(dwMc, { version })(argv)

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
      assert.include(rows, "Needs me         │ dominikwozniak/dw-mc#2")
      assert.include(rows, "Needs review run │ dominikwozniak/dw-mc#1")
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
