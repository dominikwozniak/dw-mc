import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"

import type { ConfigFile } from "#adapters/config.ts"
import { write } from "#adapters/config.ts"
import { recording } from "#adapters/picker.ts"
import { json, layerStubbed, vectorOf } from "#adapters/spawner.ts"
import { prKey, storeFor } from "#adapters/store.ts"
import { machineOf, run } from "#cli/cli.ts"
import { acknowledgedAt } from "#domain/acknowledgement.ts"
import type { Facts } from "#domain/bucket.ts"
import { Facts as FactsSchema } from "#domain/bucket.ts"

const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso)

const repo = "dominikwozniak/dw-mc"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"

const person = (login: string) => ({ login, __typename: "User" })
const bot = (login: string) => ({ login, __typename: "Bot" })

const conversation = {
  comments: {
    nodes: [
      { author: person("alice"), body: "The cutoff belongs in the domain.", createdAt: "2026-09-17T14:21:00Z" },
      { author: bot("github-actions"), body: "Coverage fell by 0.2%.", createdAt: "2026-09-17T14:40:00Z" }
    ]
  },
  reviews: {
    nodes: [
      { author: person("bob"), body: "One thing, then this is good.", submittedAt: "2026-09-17T15:02:00Z" },
      { author: person("bob"), body: "", submittedAt: "2026-09-17T15:03:00Z" }
    ]
  },
  reviewThreads: {
    nodes: [
      {
        isResolved: false,
        isOutdated: false,
        path: "src/domain/comments.ts",
        line: 42,
        comments: {
          nodes: [
            {
              author: person("bob"),
              body: "A thread nobody has settled,\nover two lines.",
              createdAt: "2026-09-17T15:04:00Z"
            }
          ]
        }
      },
      {
        isResolved: true,
        isOutdated: false,
        path: "src/adapters/gh.ts",
        line: 7,
        comments: {
          nodes: [{ author: person("bob"), body: "Settled already.", createdAt: "2026-09-17T15:05:00Z" }]
        }
      },
      {
        isResolved: false,
        isOutdated: true,
        path: "src/cli/comments.ts",
        line: null,
        comments: {
          nodes: [{ author: person("bob"), body: "Against code that is gone.", createdAt: "2026-09-17T15:06:00Z" }]
        }
      }
    ]
  }
}

/** Every program the command spawns, from fixtures, and a death for anything else. */
const machine = (options: { readonly spawned: Array<string>; readonly pullRequest?: unknown }) =>
  machineOf({
    spawner: layerStubbed({
      onSpawn: (command) => options.spawned.push(vectorOf(command)),
      stubs: [
        (_, argv) =>
          argv.startsWith("api graphql")
            ? json({ data: { repository: { pullRequest: options.pullRequest ?? conversation } } })
            : undefined
      ]
    })
  })

const registered = write({ repos: { [repo]: {} } } satisfies ConfigFile)

/** What a sweep wrote down about the pull request: where my last activity got to. */
const swept = (over: Partial<Facts>) =>
  Effect.gen(function* () {
    const store = yield* storeFor("prs", FactsSchema)
    yield* store.set(prKey(repo, 28), {
      repo,
      number: 28,
      title: "feat(comments): read a pull request's threads",
      url: `https://github.com/${repo}/pull/28`,
      draft: false,
      head,
      mergeable: "mergeable",
      reviewDecision: "none",
      checks: "green",
      ciFlaky: null,
      rebaseConflictAt: null,
      newestHumanCommentAt: null,
      myLastCommentAt: null,
      myLastCommitAt: null,
      acknowledgedAt: null,
      reviewRunHead: head,
      blockingFindings: 0,
      ...over
    })
  })

describe("dw-mc comments", () => {
  it.effect("prints what was said after my last activity, and writes nothing", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* swept({ myLastCommitAt: at("2026-09-17T14:30:00Z") })

      yield* run("comments", "28")

      const said = printed.join("\n")
      assert.include(said, "bob")
      assert.include(said, "One thing, then this is good.")
      assert.include(said, "src/domain/comments.ts:42")
      assert.include(said, "A thread nobody has settled,")
      assert.include(said, "over two lines.")
      assert.notInclude(said, "The cutoff belongs in the domain.")

      assert.strictEqual(spawned.length, 1)
      assert.match(spawned[0] ?? "", /^gh api graphql /)
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("leaves out a thread somebody resolved and one against code that is gone", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* swept({})

      yield* run("comments", "28")

      const said = printed.join("\n")
      assert.notInclude(said, "Settled already.")
      assert.notInclude(said, "Against code that is gone.")
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("prints the whole conversation under --all", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* swept({ myLastCommitAt: at("2026-09-17T16:00:00Z") })

      yield* run("comments", "28", "--all")

      const said = printed.join("\n")
      assert.include(said, "The cutoff belongs in the domain.")
      assert.include(said, "Settled already.")
      assert.include(said, "Against code that is gone.")
      assert.include(said, "src/adapters/gh.ts:7  (resolved)")
      assert.include(said, "src/cli/comments.ts  (outdated)")
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("keeps a bot below a rule of its own", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* swept({})

      yield* run("comments", "28")

      const said = printed.join("\n")
      const rule = said.indexOf("bots")
      assert.isAbove(rule, -1)
      assert.isAbove(said.indexOf("Coverage fell by 0.2%."), rule)
      assert.isBelow(said.indexOf("The cutoff belongs in the domain."), rule)
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("says what settles a pull request in Needs me with nothing left to read", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    /** Everything anybody said is settled, and none of it is an answer of mine. */
    const settled = {
      comments: { nodes: [] },
      reviews: { nodes: [] },
      reviewThreads: {
        nodes: [
          {
            isResolved: true,
            isOutdated: false,
            path: "src/adapters/gh.ts",
            line: 7,
            comments: {
              nodes: [{ author: person("bob"), body: "Settled already.", createdAt: "2026-09-17T15:05:00Z" }]
            }
          }
        ]
      }
    }

    return Effect.gen(function* () {
      yield* registered
      yield* swept({ newestHumanCommentAt: at("2026-09-17T15:05:00Z") })

      yield* run("comments", "28")

      const said = printed.join("\n")
      assert.include(said, "Needs me")
      assert.include(said, "--all")
      assert.notInclude(said, "Settled already.")
    }).pipe(Effect.provide(machine({ spawned, pullRequest: settled })), recording(printed))
  })

  it.effect("records nothing without --ack", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* swept({})

      yield* run("comments", "28")

      assert.isNull(yield* acknowledgedAt(repo, 28))
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("acknowledges the newest thing a person said under --ack, settled threads and all", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* swept({ newestHumanCommentAt: at("2026-09-17T15:06:00Z") })

      yield* run("comments", "28", "--ack")

      assert.deepStrictEqual(yield* acknowledgedAt(repo, 28), at("2026-09-17T15:06:00Z"))
      const said = printed.join("\n")
      assert.include(said, "One thing, then this is good.")
      assert.include(said, "Acknowledged")
      assert.include(said, "2026-09-17T15:06:00.000Z")
      assert.include(said, "Ready")
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("acknowledges nothing where no person has said anything", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    const quiet = {
      comments: {
        nodes: [{ author: bot("github-actions"), body: "Coverage fell.", createdAt: "2026-09-17T14:40:00Z" }]
      },
      reviews: { nodes: [] },
      reviewThreads: { nodes: [] }
    }

    return Effect.gen(function* () {
      yield* registered
      yield* swept({})

      yield* run("comments", "28", "--ack")

      assert.isNull(yield* acknowledgedAt(repo, 28))
      assert.include(printed.join("\n"), "Nothing to acknowledge")
    }).pipe(Effect.provide(machine({ spawned, pullRequest: quiet })), recording(printed))
  })

  it.effect("leaves out what my acknowledgement already covers", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* swept({ myLastCommitAt: at("2026-09-17T14:30:00Z"), acknowledgedAt: at("2026-09-17T15:02:00Z") })

      yield* run("comments", "28")

      const said = printed.join("\n")
      assert.notInclude(said, "One thing, then this is good.")
      assert.include(said, "A thread nobody has settled,")
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("sends me to a sweep where nothing is known about the pull request", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered

      const error = yield* Effect.flip(run("comments", "28"))

      assert.include(String(error.cause), "dw-mc sweep")
      assert.deepStrictEqual(spawned, [])
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })
})
