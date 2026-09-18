import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Option } from "effect"

import type { ConfigFile } from "#adapters/config.ts"
import { write } from "#adapters/config.ts"
import { prViewOf, viewFields } from "#adapters/gh.ts"
import { coloured, Paint } from "#adapters/paint.ts"
import { recording } from "#adapters/picker.ts"
import { json, layerStubbed, refused, vectorOf, wrote } from "#adapters/spawner.ts"
import { storeFor } from "#adapters/store.ts"
import { machineOf, run } from "#cli/cli.ts"
import { Facts } from "#domain/bucket.ts"
import type { Finding } from "#domain/findings.ts"
import { ReviewRun, runKey } from "#domain/review.ts"
import { withdraw } from "#domain/stamp.ts"

const me = "dominikwozniak"

/** One comment, in the shape the REST endpoints answer with. */
const comment = (login: string, at: string, type: "User" | "Bot" = "User") => ({
  created_at: at,
  user: { login, type }
})

/** One review, in the shape the REST endpoint answers with. */
const review = (login: string, at: string, body: string, type: "User" | "Bot" = "User") => ({
  submitted_at: at,
  body,
  user: { login, type }
})

/** One commit, in the shape `gh pr view --json commits` answers with. */
const commit = (login: string, at: string) => ({
  committedDate: at,
  authors: [{ login }],
  messageHeadline: "feat: a commit",
  messageBody: "with a body long enough to be worth not reading twice"
})

/** One check run, in the shape `statusCheckRollup` answers with. */
const check = (name: string, conclusion: string, status = "COMPLETED", workflowName = "Quality gate") => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  workflowName
})

/** What `gh` says on stderr instead of answering about a repository. */
interface Refusal {
  readonly refuses: string
}

interface Fixture {
  readonly number: number
  readonly title?: string
  readonly isDraft?: boolean
  readonly mergeable?: string
  readonly reviewDecision?: string
  readonly headRefOid?: string
  readonly rollup?: ReadonlyArray<ReturnType<typeof check>>
  readonly comments?: ReadonlyArray<ReturnType<typeof comment>>
  readonly onDiff?: ReadonlyArray<ReturnType<typeof comment>>
  readonly reviews?: ReadonlyArray<ReturnType<typeof review>>
  readonly commits?: ReadonlyArray<ReturnType<typeof commit>>
  /** The paths `gh pr view --json files` answers with. */
  readonly files?: ReadonlyArray<string>
  /** What the failing jobs of this PR printed. */
  readonly log?: string
  /** What `gh` says on stderr instead of answering about this PR. */
  readonly refuses?: string
}

const view = (repo: string, pr: Fixture) =>
  prViewOf(repo, {
    number: pr.number,
    title: pr.title,
    isDraft: pr.isDraft,
    headRefOid: pr.headRefOid,
    mergeable: pr.mergeable,
    reviewDecision: pr.reviewDecision,
    // Every check of a PR reports at the same job, whose id is the PR's number,
    // so a stubbed log is found from the URL the classifier follows.
    statusCheckRollup: (pr.rollup ?? [check("Check", "SUCCESS")]).map((entry) => ({
      ...entry,
      detailsUrl: `https://github.com/${repo}/actions/runs/1/job/${pr.number}`
    }))
  })

/**
 * A `gh` that answers the six reads a sweep makes, from fixtures, and dies on
 * anything else - which is what keeps a write out of the sweep honest.
 */
const github = (options: {
  readonly repos: Record<string, ReadonlyArray<Fixture> | Refusal>
  readonly spawned?: Array<string> | undefined
  /** The workflows that are failing on the default branch as well. */
  readonly redOnDefaultBranch?: ReadonlyArray<string> | undefined
}) => {
  const found = (repo: string, number: string): Fixture | undefined => {
    const prs = options.repos[repo]
    return prs === undefined || "refuses" in prs ? undefined : prs.find((pr) => pr.number === Number(number))
  }

  return layerStubbed({
    onSpawn: (command) => options.spawned?.push(vectorOf(command)),
    stubs: [
      (_, argv) => (argv === "api user" ? json({ login: me }) : undefined),
      (_, argv) => {
        const search = /^search prs .* --repo (\S+) /.exec(argv)
        if (search === null) {
          return undefined
        }
        const repo = search[1] ?? ""
        const prs = options.repos[repo]
        if (prs === undefined) {
          return refused(`no such repository ${repo}`)
        }
        if ("refuses" in prs) {
          return refused(prs.refuses)
        }
        return json(prs.map((pr) => ({ number: pr.number, repository: { nameWithOwner: repo } })))
      },
      (_, argv) => {
        const detail = /^pr view (\d+) --repo (\S+) --json (\S+)$/.exec(argv)
        if (detail === null) {
          return undefined
        }
        const [, number = "", repo = "", fields = ""] = detail
        const pr = found(repo, number)
        if (pr === undefined) {
          return refused(`no pull request ${repo}#${number}`)
        }
        if (pr.refuses !== undefined) {
          return refused(pr.refuses)
        }
        if (fields === "commits") {
          return json({ commits: pr.commits ?? [] })
        }
        if (fields === "files") {
          return json({ files: (pr.files ?? []).map((path) => ({ path })) })
        }
        return json(view(repo, pr))
      },
      (_, argv) =>
        /^repo view \S+ --json defaultBranchRef$/.test(argv) ? json({ defaultBranchRef: { name: "main" } }) : undefined,
      (_, argv) => {
        const runs = /^run list --repo \S+ --branch main --workflow (.+) --limit 5 --json conclusion$/.exec(argv)
        return runs === null
          ? undefined
          : json([{ conclusion: options.redOnDefaultBranch?.includes(runs[1] ?? "") === true ? "failure" : "success" }])
      },
      (_, argv) => {
        const logs = /^api repos\/(\S+?)\/actions\/jobs\/(\d+)\/logs --allow-escape-sequences$/.exec(argv)
        const [, repo = "", job = ""] = logs ?? []
        return logs === null ? undefined : wrote(found(repo, job)?.log ?? "")
      },
      (_, argv) => {
        const reviews = /^api repos\/(\S+?)\/pulls\/(\d+)\/reviews\?per_page=100$/.exec(argv)
        if (reviews === null) {
          return undefined
        }
        const [, repo = "", number = ""] = reviews
        const pr = found(repo, number)
        return pr === undefined ? refused(`no pull request ${repo}#${number}`) : json(pr.reviews ?? [])
      },
      (_, argv) => {
        const rest = /^api repos\/(\S+?)\/(issues|pulls)\/(\d+)\/comments\?per_page=100$/.exec(argv)
        if (rest === null) {
          return undefined
        }
        const [, repo = "", kind = "", number = ""] = rest
        const pr = found(repo, number)
        return pr === undefined
          ? refused(`no pull request ${repo}#${number}`)
          : json((kind === "issues" ? pr.comments : pr.onDiff) ?? [])
      }
    ]
  })
}

/** Everything the two commands run on, and nothing else: one fake `gh`, an
 * in-memory configuration file and an in-memory state directory. */
const machine = (spawner: ReturnType<typeof github>, drawn?: Array<string>, columns?: number) =>
  machineOf({ spawner, drawn, columns })

const registered = (...repos: ReadonlyArray<string>) =>
  write({ repos: Object.fromEntries(repos.map((repo) => [repo, {}])) } satisfies ConfigFile)

/** What `dw-mc review` leaves behind: a review run against one head. */
const reviewed = (repo: string, number: number, head: string, findings: ReadonlyArray<Finding> = []) =>
  Effect.flatMap(storeFor("runs", ReviewRun), (runs) =>
    runs.set(runKey(repo, number, head), {
      repo,
      number,
      head,
      command: "/code-review",
      effort: "low",
      sessionId: "befb6186-5471-4b26-b680-e8ca49df25ac",
      outcome: { _tag: "reported", verdict: findings.length === 0 ? "clean" : "findings", findings },
      ranAt: DateTime.makeUnsafe("2026-09-16T14:21:00Z")
    })
  )

describe("dw-mc status", () => {
  it.effect("says how far the sweep has got while it runs, and leaves the table behind", () => {
    const printed: Array<string> = []
    const drawn: Array<string> = []
    const spawner = github({
      repos: {
        "dominikwozniak/dw-mc": [
          { number: 1, title: "feat: one" },
          { number: 2, title: "feat: two" }
        ],
        "byarcadia-app/grateful-me-app-v2": [{ number: 105, title: "feat: three" }]
      }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc", "byarcadia-app/grateful-me-app-v2")
      yield* run("status")

      const screen = drawn.join("\n")
      // Both stages count, and the second counts towards a total only the
      // searches could have answered.
      assert.include(screen, "sweeping · 2 of 2 repositories")
      assert.include(screen, "sweeping · 3 of 3 pull requests")
      // What is left on the screen is the table, and the heartbeat is wiped.
      assert.match(drawn.at(-1) ?? "", /^\r +\r$/)
      assert.strictEqual(printed.length, 4)
    }).pipe(Effect.provide(machine(spawner, drawn)), recording(printed))
  })

  it.effect("says nothing of the sweep where there is no screen to draw on", () => {
    const printed: Array<string> = []
    const drawn: Array<string> = []
    const spawner = github({
      repos: { "dominikwozniak/dw-mc": [{ number: 1, title: "feat: conflicted", mergeable: "CONFLICTING" }] }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("status")

      // A pipe reads what it read before there was a heartbeat at all.
      assert.deepStrictEqual(drawn, [])
      assert.deepStrictEqual(printed, ["Needs me", "  ● dominikwozniak/dw-mc#1 │ feat: conflicted │ merge conflict"])
    }).pipe(Effect.provide(machine(spawner, drawn, 0)), recording(printed))
  })

  it.effect("prints every tracked PR under its bucket, hardest first", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: {
        "dominikwozniak/dw-mc": [
          { number: 1, title: "feat: ready to merge", reviewDecision: "APPROVED" },
          { number: 2, title: "feat: conflicted", mergeable: "CONFLICTING" },
          { number: 3, title: "feat: waiting on a reviewer", reviewDecision: "REVIEW_REQUIRED" }
        ]
      }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("status")

      assert.deepStrictEqual(printed, [
        "Needs me",
        "  ● dominikwozniak/dw-mc#2 │ feat: conflicted            │ merge conflict",
        "",
        "Needs review run",
        "  ◐ dominikwozniak/dw-mc#1 │ feat: ready to merge        │ no review run on this head",
        "  ◐ dominikwozniak/dw-mc#3 │ feat: waiting on a reviewer │ no review run on this head"
      ])
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("says the bucket in colour where a terminal is watching", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: { "dominikwozniak/dw-mc": [{ number: 1, title: "feat: conflicted", mergeable: "CONFLICTING" }] }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("status")

      const row = printed.find((line) => line.includes("#1")) ?? ""
      assert.include(row, coloured.red("●"), "the marker carries the bucket's colour")
      assert.include(row, coloured.red("merge conflict"), "and so does what it waits on")
      assert.include(row, coloured.dim("feat: conflicted"), "the title is context, so it is dimmed")
      assert.strictEqual(printed[0], "Needs me", "the heading is prose, and prose is never coloured")
    }).pipe(Effect.provide(machine(spawner)), Effect.provideService(Paint, coloured), recording(printed))
  })

  it.effect("gives the pull request the URL it opens at, where a terminal can follow one", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: { "dominikwozniak/dw-mc": [{ number: 1, title: "feat: a pull request" }] }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("status")

      const row = printed.find((line) => line.includes("#1")) ?? ""
      assert.include(
        row,
        coloured.link("dominikwozniak/dw-mc#1", "https://github.com/dominikwozniak/dw-mc/pull/1"),
        "the reference carries the pull request's URL"
      )
    }).pipe(Effect.provide(machine(spawner)), Effect.provideService(Paint, coloured), recording(printed))
  })

  it.effect("leaves the link out where nothing is watching, so a pipe reads the plain reference", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: { "dominikwozniak/dw-mc": [{ number: 1, title: "feat: a pull request" }] }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("status")

      const row = printed.find((line) => line.includes("#1")) ?? ""
      assert.notInclude(row, "https://github.com", "a pipe gets what a terminal gets, minus the colour and the link")
      assert.notInclude(row, "\x1b")
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("says why a PR needs me, so I never open GitHub to find out", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: {
        "dominikwozniak/dw-mc": [
          { number: 1, title: "feat: red", rollup: [check("Check", "FAILURE")] },
          { number: 2, title: "feat: rejected", reviewDecision: "CHANGES_REQUESTED" },
          {
            number: 3,
            title: "feat: answered me",
            comments: [comment("someone", "2026-09-15T09:00:00Z")],
            commits: [commit(me, "2026-09-15T08:00:00Z")]
          }
        ]
      }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("status")

      assert.deepStrictEqual(
        printed.filter((line) => line.startsWith("  ")).map((line) => line.split(" │ ").at(-1)),
        ["CI is red", "changes requested", "a comment I have not answered"]
      )
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("ignores a bot's comment, because a bot is not a person waiting on me", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: {
        "dominikwozniak/dw-mc": [
          {
            number: 1,
            comments: [comment("coderabbitai[bot]", "2026-09-15T09:00:00Z", "Bot")],
            commits: [commit(me, "2026-09-15T08:00:00Z")]
          }
        ]
      }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("status")

      assert.deepStrictEqual(printed[0], "Needs review run")
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("counts a comment left on the diff as a comment", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: {
        "dominikwozniak/dw-mc": [
          {
            number: 1,
            onDiff: [comment("someone", "2026-09-15T09:00:00Z")],
            commits: [commit(me, "2026-09-15T08:00:00Z")]
          }
        ]
      }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("status")

      assert.deepStrictEqual(printed[0], "Needs me")
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("counts the body of a review as a comment", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: {
        "dominikwozniak/dw-mc": [
          {
            number: 1,
            reviews: [review("someone", "2026-09-15T09:00:00Z", "one thought before I approve")],
            commits: [commit(me, "2026-09-15T08:00:00Z")]
          }
        ]
      }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("status")

      assert.strictEqual(printed[0], "Needs me")
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("passes over a review that said nothing but its verdict", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: {
        "dominikwozniak/dw-mc": [
          {
            number: 1,
            reviews: [review("someone", "2026-09-15T09:00:00Z", "")],
            commits: [commit(me, "2026-09-15T08:00:00Z")]
          }
        ]
      }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("status")

      assert.strictEqual(printed[0], "Needs review run")
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("marks a draft and still gives it a bucket", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: { "dominikwozniak/dw-mc": [{ number: 7, title: "feat: not yet", isDraft: true }] }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("status")

      assert.deepStrictEqual(printed, [
        "Needs review run",
        "  ◐ dominikwozniak/dw-mc#7 (draft) │ feat: not yet │ no review run on this head"
      ])
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("keeps the rest of the table when one repository will not load", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: {
        "dominikwozniak/dw-mc": [{ number: 1, title: "feat: fine" }],
        "dominikwozniak/gone": { refuses: "could not resolve to a Repository" }
      }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc", "dominikwozniak/gone")
      yield* run("status")

      assert.deepStrictEqual(printed, [
        "Needs review run",
        "  ◐ dominikwozniak/dw-mc#1 │ feat: fine │ no review run on this head",
        "",
        "Could not load",
        "  dominikwozniak/gone  gh search prs failed: could not resolve to a Repository"
      ])
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("keeps the rest of the table when one pull request will not load", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: {
        "dominikwozniak/dw-mc": [
          { number: 1, title: "feat: fine" },
          { number: 2, refuses: "GraphQL: Something went wrong" }
        ]
      }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("status")

      assert.include(printed, "  ◐ dominikwozniak/dw-mc#1 │ feat: fine │ no review run on this head")
      assert.include(printed, "  dominikwozniak/dw-mc#2  gh pr view failed: GraphQL: Something went wrong")
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("has nothing to show before a repository is registered", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* run("status")

      assert.deepStrictEqual(printed, [
        "No repositories registered. Run dw-mc init inside a repository to register it."
      ])
    }).pipe(Effect.provide(machine(github({ repos: {} }))), recording(printed))
  })

  it.effect("says so when a registered repository has no open pull requests", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("status")

      assert.deepStrictEqual(printed, ["No open pull requests."])
    }).pipe(Effect.provide(machine(github({ repos: { "dominikwozniak/dw-mc": [] } }))), recording(printed))
  })
})

describe("dw-mc sweep", () => {
  it.effect("refreshes every tracked PR in one pass and says what it covered", () => {
    const printed: Array<string> = []
    const spawned: Array<string> = []
    const spawner = github({
      spawned,
      repos: {
        "dominikwozniak/dw-mc": [{ number: 1 }, { number: 2 }],
        "byarcadia-app/grateful-me-app-v2": [{ number: 105 }]
      }
    })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc", "byarcadia-app/grateful-me-app-v2")
      yield* run("sweep")

      assert.deepStrictEqual(printed, ["Swept 3 pull requests across 2 repositories"])
      assert.deepStrictEqual(spawned.filter((argv) => argv.startsWith("gh search")).toSorted(), [
        "gh search prs --author=@me --state=open --repo byarcadia-app/grateful-me-app-v2 --limit 100 --json number,repository",
        "gh search prs --author=@me --state=open --repo dominikwozniak/dw-mc --limit 100 --json number,repository"
      ])
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("only ever reads GitHub", () => {
    const spawned: Array<string> = []
    const spawner = github({ spawned, repos: { "dominikwozniak/dw-mc": [{ number: 1 }] } })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("sweep")

      assert.isAbove(spawned.length, 0)
      for (const argv of spawned) {
        // `gh api` defaults to GET, `gh pr view` and `gh search` cannot write,
        // and a write would need one of the flags or verbs named here.
        assert.match(argv, /^gh (api|search prs|pr view) /)
        assert.notMatch(argv, /(--method|-X|--field|-f |--input)/)
      }
    }).pipe(Effect.provide(machine(spawner)), recording([]))
  })

  it.effect("skips the expensive read for a PR that is where it was left", () => {
    const spawned: Array<string> = []
    const spawner = github({
      spawned,
      repos: {
        "dominikwozniak/dw-mc": [{ number: 1, commits: [commit(me, "2026-09-15T08:00:00Z")] }]
      }
    })
    const commits = (argv: string) => argv.endsWith("--json commits")

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")

      yield* run("sweep")
      assert.strictEqual(spawned.filter(commits).length, 1)

      spawned.length = 0
      yield* run("sweep")
      assert.deepStrictEqual(spawned.filter(commits), [])
      // The cheap reads still happen: they are what says the PR is quiet.
      assert.strictEqual(spawned.filter((argv) => argv.startsWith("gh pr view")).length, 1)
    }).pipe(Effect.provide(machine(spawner)), recording([]))
  })

  it.effect("reads the PR out again when its head has moved", () => {
    const spawned: Array<string> = []
    const prs: Array<Fixture> = [{ number: 1, headRefOid: "aaaa" }]
    const spawner = github({ spawned, repos: { "dominikwozniak/dw-mc": prs } })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("sweep")

      prs[0] = { number: 1, headRefOid: "bbbb" }
      spawned.length = 0
      yield* run("sweep")

      assert.strictEqual(spawned.filter((argv) => argv.endsWith("--json commits")).length, 1)
    }).pipe(Effect.provide(machine(spawner)), recording([]))
  })

  it.effect("keeps the review run on a head a comment did not move", () => {
    const head = "31268022360852f71815404b6bbdd6bd797cfb4c"
    const printed: Array<string> = []
    const prs: Array<Fixture> = [{ number: 1, title: "feat: reviewed" }]
    const spawner = github({ repos: { "dominikwozniak/dw-mc": prs } })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("sweep")

      yield* reviewed("dominikwozniak/dw-mc", 1, head)
      const store = yield* storeFor("prs", Facts)
      const key = "dominikwozniak/dw-mc#1"

      prs[0] = { number: 1, title: "feat: reviewed", comments: [comment("someone", "2026-09-15T09:00:00Z")] }
      printed.length = 0
      yield* run("status")

      assert.deepStrictEqual(printed[0], "Needs me")
      assert.strictEqual(Option.getOrThrow(yield* store.get(key)).reviewRunHead, head)
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("forgets the review run once the head has moved", () => {
    const printed: Array<string> = []
    const prs: Array<Fixture> = [{ number: 1, headRefOid: "aaaa" }]
    const spawner = github({ repos: { "dominikwozniak/dw-mc": prs } })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/dw-mc")
      yield* run("sweep")

      yield* reviewed("dominikwozniak/dw-mc", 1, "aaaa")
      const store = yield* storeFor("prs", Facts)
      const key = "dominikwozniak/dw-mc#1"

      prs[0] = { number: 1, headRefOid: "bbbb" }
      printed.length = 0
      yield* run("status")

      assert.strictEqual(printed[0], "Needs review run")
      assert.strictEqual(Option.getOrThrow(yield* store.get(key)).reviewRunHead, null)
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("reports what it could not load", () => {
    const printed: Array<string> = []
    const spawner = github({ repos: { "dominikwozniak/gone": { refuses: "could not resolve to a Repository" } } })

    return Effect.gen(function* () {
      yield* registered("dominikwozniak/gone")
      yield* run("sweep")

      assert.deepStrictEqual(printed, [
        "Swept 0 pull requests across 1 repository",
        "",
        "Could not load",
        "  dominikwozniak/gone  gh search prs failed: could not resolve to a Repository"
      ])
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })
})

describe("a red CI, classified", () => {
  const repo = "dominikwozniak/dw-mc"
  const red = [check("Check", "FAILURE")]

  /** The reason column of every row, which is where a verdict shows up. */
  const reasons = (printed: ReadonlyArray<string>) =>
    printed.filter((line) => line.startsWith("  ")).map((line) => line.split(" │ ").at(-1))

  it.effect("keeps a PR out of Needs me when the same workflow is red on the default branch", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: { [repo]: [{ number: 1, title: "feat: flaky", rollup: red, reviewDecision: "APPROVED" }] },
      redOnDefaultBranch: ["Quality gate"]
    })

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* run("status")

      assert.strictEqual(printed[0], "Needs review run")
      assert.strictEqual(
        Option.getOrThrow(yield* storeFor("prs", Facts).pipe(Effect.flatMap((store) => store.get(`${repo}#1`))))
          .ciFlaky,
        "Quality gate is red on the default branch too"
      )
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("keeps a PR out of Needs me when the log matches a known flaky pattern", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: { [repo]: [{ number: 1, rollup: red, log: "Error: connect ETIMEDOUT 140.82.121.4:443" }] }
    })

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* run("status")

      assert.strictEqual(printed[0], "Needs review run")
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("hands the PR back to me when the failing log names a file it changes", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: {
        [repo]: [
          {
            number: 1,
            rollup: red,
            files: ["src/domain/flaky.ts"],
            log: "connect ETIMEDOUT\nFAIL src/domain/flaky.ts:12:3\n"
          }
        ]
      },
      redOnDefaultBranch: ["Quality gate"]
    })

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* run("status")

      assert.strictEqual(printed[0], "Needs me")
      assert.deepStrictEqual(reasons(printed), ["CI is red"])
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("hands the PR back to me when nothing explains the failure", () => {
    const printed: Array<string> = []
    const spawner = github({ repos: { [repo]: [{ number: 1, rollup: red, log: "Error: expected 3 to be 4" }] } })

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* run("status")

      assert.strictEqual(printed[0], "Needs me")
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("honours a flaky pattern I added to the repository's configuration", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: { [repo]: [{ number: 1, rollup: red, log: "Error: Chromium revision is not downloaded" }] }
    })

    return Effect.gen(function* () {
      yield* write({ repos: { [repo]: { ci: { flaky_patterns: ["Chromium revision is not downloaded"] } } } })
      yield* run("status")

      assert.strictEqual(printed[0], "Needs review run")
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("never classifies a check ci.ignore says does not count", () => {
    const printed: Array<string> = []
    const spawned: Array<string> = []
    const spawner = github({
      repos: { [repo]: [{ number: 1, rollup: [check("Check", "SUCCESS"), check("codecov", "FAILURE")] }] },
      spawned
    })

    return Effect.gen(function* () {
      yield* write({ repos: { [repo]: { ci: { ignore: ["codecov"] } } } })
      yield* run("status")

      assert.strictEqual(printed[0], "Needs review run")
      assert.isFalse(spawned.some((argv) => argv.includes("/logs")))
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("says a red CI it excused out loud rather than calling the PR clean", () => {
    const printed: Array<string> = []
    const head = "31268022360852f71815404b6bbdd6bd797cfb4c"
    const spawner = github({
      repos: { [repo]: [{ number: 1, rollup: red, reviewDecision: "APPROVED" }] },
      redOnDefaultBranch: ["Quality gate"]
    })

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* run("sweep")

      yield* reviewed(repo, 1, head)
      printed.length = 0
      yield* run("status")

      assert.strictEqual(printed[0], "Ready")
      assert.deepStrictEqual(reasons(printed), [
        "approved, mergeable (red CI called flaky: Quality gate is red on the default branch too)"
      ])
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("classifies once and stands by it while the PR sits still", () => {
    const printed: Array<string> = []
    const spawned: Array<string> = []
    const spawner = github({
      repos: { [repo]: [{ number: 1, rollup: red, log: "connect ETIMEDOUT" }] },
      spawned
    })

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* run("sweep")
      const first = spawned.filter((argv) => argv.includes("/logs")).length
      yield* run("sweep")

      assert.strictEqual(first, 1)
      assert.strictEqual(spawned.filter((argv) => argv.includes("/logs")).length, first)
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("reports a legitimate failure and never tries to fix it", () => {
    const printed: Array<string> = []
    const spawned: Array<string> = []
    const spawner = github({
      repos: { [repo]: [{ number: 1, rollup: red, files: ["src/cli/sweep.ts"], log: "FAIL src/cli/sweep.ts:1:1" }] },
      spawned
    })

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* run("status")

      assert.strictEqual(printed[0], "Needs me")
      // Every program a sweep spawns, in full and unfiltered: a write would
      // have to appear in this list, and a filtered one is where it would hide.
      assert.deepStrictEqual(spawned.toSorted(), [
        "gh api repos/dominikwozniak/dw-mc/actions/jobs/1/logs --allow-escape-sequences",
        "gh api repos/dominikwozniak/dw-mc/issues/1/comments?per_page=100",
        "gh api repos/dominikwozniak/dw-mc/pulls/1/comments?per_page=100",
        "gh api repos/dominikwozniak/dw-mc/pulls/1/reviews?per_page=100",
        "gh api user",
        `gh pr view 1 --repo ${repo} --json commits`,
        `gh pr view 1 --repo ${repo} --json files`,
        `gh pr view 1 --repo ${repo} --json ${viewFields}`,
        `gh repo view ${repo} --json defaultBranchRef`,
        `gh run list --repo ${repo} --branch main --workflow Quality gate --limit 5 --json conclusion`,
        `gh search prs --author=@me --state=open --repo ${repo} --limit 100 --json number,repository`
      ])
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })
})

describe("the stamp in the table", () => {
  const repo = "dominikwozniak/dw-mc"
  const head = "31268022360852f71815404b6bbdd6bd797cfb4c"
  const warning: Finding = { file: "src/cli/status.ts", line: 20, severity: "warning", summary: "A long row." }

  it.effect("marks the PR that passed my bar, and leaves the rest unmarked", () => {
    const printed: Array<string> = []
    const spawner = github({
      repos: {
        [repo]: [
          { number: 1, title: "feat: stamped" },
          { number: 2, title: "feat: unreviewed" }
        ]
      }
    })

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* reviewed(repo, 1, head)
      yield* run("status")

      assert.deepStrictEqual(printed, [
        "Needs review run",
        `  ◐ ${repo}#2   │ feat: unreviewed │ no review run on this head`,
        "",
        "Ready",
        `  ◆ ${repo}#1 ✓ │ feat: stamped    │ green, mergeable`
      ])
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("drops the mark from a stamp I withdrew by hand", () => {
    const printed: Array<string> = []
    const spawner = github({ repos: { [repo]: [{ number: 1, title: "feat: stamped" }] } })

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* reviewed(repo, 1, head)
      yield* withdraw(repo, 1, head)
      yield* run("status")

      assert.deepStrictEqual(printed, ["Ready", `  ◆ ${repo}#1 │ feat: stamped │ green, mergeable`])
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("withholds it where stamp.blocks_on says a warning blocks", () => {
    const printed: Array<string> = []
    const spawner = github({ repos: { [repo]: [{ number: 1, title: "feat: one warning" }] } })

    return Effect.gen(function* () {
      yield* write({ repos: { [repo]: { stamp: { blocks_on: "warning" } } } })
      yield* reviewed(repo, 1, head, [warning])
      yield* run("status")

      assert.deepStrictEqual(printed, ["Needs me", `  ● ${repo}#1 │ feat: one warning │ 1 blocking finding`])
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })

  it.effect("keeps it where the bar is the error it is by default", () => {
    const printed: Array<string> = []
    const spawner = github({ repos: { [repo]: [{ number: 1, title: "feat: one warning" }] } })

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* reviewed(repo, 1, head, [warning])
      yield* run("status")

      assert.deepStrictEqual(printed, ["Ready", `  ◆ ${repo}#1 ✓ │ feat: one warning │ green, mergeable`])
    }).pipe(Effect.provide(machine(spawner)), recording(printed))
  })
})
