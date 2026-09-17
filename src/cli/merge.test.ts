import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Console, DateTime, Effect, FileSystem, Layer, Path, Stdio } from "effect"
import { Command } from "effect/unstable/cli"

import type { ConfigFile } from "#adapters/config.ts"
import { ConfigStore, write } from "#adapters/config.ts"
import { layerScripted } from "#adapters/picker.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"
import * as Store from "#adapters/store.ts"
import { prKey, storeFor } from "#adapters/store.ts"
import { dwMc, version } from "#cli/cli.ts"
import { Facts } from "#domain/bucket.ts"
import type { Finding } from "#domain/findings.ts"
import { LastReviewed, latestKey, ReviewRun, runKey } from "#domain/review.ts"
import { withdraw } from "#domain/stamp.ts"

const me = "dominikwozniak"
const repo = "dominikwozniak/dw-mc"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"
const gone = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"

const passed = { name: "Check", status: "COMPLETED", conclusion: "SUCCESS" }
const failed = { name: "Check", status: "COMPLETED", conclusion: "FAILURE" }

/** Every program the command spawns, from fixtures, and a death for anything else. */
const machine = (options: {
  readonly spawned: Array<string>
  readonly checks?: ReadonlyArray<Record<string, string>> | undefined
  readonly reviewDecision?: string | undefined
  readonly mergeable?: string | undefined
  readonly draft?: boolean | undefined
  readonly author?: string | undefined
  /** What `gh pr merge` said when it refused, where it refused. */
  readonly refusal?: string | undefined
}) => {
  const spawner = layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("merge.test: the fake was handed a piped command")
    }
    const argv = command.args.join(" ")
    options.spawned.push(`${command.command} ${argv}`)

    if (argv === "api user") {
      return Effect.succeed(fakeHandle({ stdout: JSON.stringify({ login: me }) }))
    }
    if (/^pr view 28 --repo \S+ --json \S+$/.test(argv)) {
      return Effect.succeed(
        fakeHandle({
          stdout: JSON.stringify({
            number: 28,
            title: "feat(merge): merge my own pull request",
            url: `https://github.com/${repo}/pull/28`,
            isDraft: options.draft ?? false,
            headRefOid: head,
            headRefName: "feat/57-merge-command",
            baseRefName: "main",
            author: { login: options.author ?? me },
            isCrossRepository: false,
            mergeable: options.mergeable ?? "MERGEABLE",
            reviewDecision: options.reviewDecision ?? "APPROVED",
            statusCheckRollup: options.checks ?? [passed]
          })
        })
      )
    }
    if (argv.startsWith("pr merge")) {
      return Effect.succeed(
        options.refusal === undefined ? fakeHandle({}) : fakeHandle({ exitCode: 1, stderr: options.refusal })
      )
    }
    return Effect.die(`merge.test: nothing stubbed for '${command.command} ${argv}'`)
  })

  return Layer.provideMerge(
    Layer.mergeAll(ConfigStore.layerTest, Store.layerTest),
    Layer.mergeAll(
      ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/home/dw" })),
      FileSystem.layerNoop({}),
      Path.layer,
      Stdio.layerTest({}),
      spawner,
      layerScripted([])
    )
  )
}

const recording = (printed: Array<string>) => {
  const console_: Console.Console = Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
    error: () => {}
  })
  return Effect.provideService(Console.Console, console_)
}

const registered = write({ repos: { [repo]: {} } } satisfies ConfigFile)

/** What `dw-mc review` leaves behind: a review run against one head. */
const reviewed = (at: string, findings: ReadonlyArray<Finding> = []) =>
  Effect.gen(function* () {
    const runs = yield* storeFor("runs", ReviewRun)
    const latest = yield* storeFor("runs", LastReviewed)
    yield* runs.set(runKey(repo, 28, at), {
      repo,
      number: 28,
      head: at,
      command: "/code-review",
      effort: "low",
      sessionId: "befb6186-5471-4b26-b680-e8ca49df25ac",
      ranAt: DateTime.makeUnsafe("2026-09-17T14:21:00Z"),
      outcome: { _tag: "reported", verdict: findings.length === 0 ? "clean" : "findings", findings }
    })
    yield* latest.set(latestKey(repo, 28), { head: at })
  })

/** What a sweep wrote down about the pull request, which is not what the guards read. */
const swept = (over: Partial<Facts>) =>
  Effect.gen(function* () {
    const store = yield* storeFor("prs", Facts)
    yield* store.set(prKey(repo, 28), {
      repo,
      number: 28,
      title: "feat(merge): merge my own pull request",
      url: `https://github.com/${repo}/pull/28`,
      draft: false,
      head,
      mergeable: "mergeable",
      reviewDecision: "approved",
      checks: "green",
      ciFlaky: null,
      rebaseConflictAt: null,
      newestHumanCommentAt: null,
      myLastCommentAt: null,
      myLastCommitAt: null,
      reviewRunHead: head,
      blockingFindings: 0,
      ...over
    })
  })

const dwmc = (...argv: ReadonlyArray<string>) => Command.runWith(dwMc, { version })(argv)

const merges = (spawned: ReadonlyArray<string>) => spawned.filter((vector) => vector.startsWith("gh pr merge"))

describe("dw-mc merge", () => {
  it.effect("squash-merges a Ready, stamped pull request and deletes its branch", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* reviewed(head)

      yield* dwmc("merge", "28")

      assert.deepStrictEqual(merges(spawned), [`gh pr merge 28 --repo ${repo} --squash --delete-branch`])
      const said = printed.join("\n")
      assert.include(said, "squash-merged into main")
      assert.include(said, "feat/57-merge-command deleted")
      assert.include(said, "feat(merge): merge my own pull request")
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("merges one nobody was required to review", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* reviewed(head)

      yield* dwmc("merge", "28")

      assert.strictEqual(merges(spawned).length, 1)
    }).pipe(Effect.provide(machine({ spawned, reviewDecision: "" })), recording(printed))
  })

  it.effect("refuses a Ready pull request that carries no stamp, and names what earns one", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered

      const error = yield* Effect.flip(dwmc("merge", "28"))

      assert.include(String(error.cause), "no review run on this head")
      assert.include(String(error.cause), "dw-mc review 28")
      assert.deepStrictEqual(merges(spawned), [])
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("refuses one a review run found something blocking on", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* reviewed(head, [
        { file: "src/cli/merge.ts", line: 12, severity: "error", summary: "The guards are read off a sweep." }
      ])

      const error = yield* Effect.flip(dwmc("merge", "28"))

      assert.include(String(error.cause), "1 blocking finding")
      assert.include(String(error.cause), "dw-mc fix 28")
      assert.deepStrictEqual(merges(spawned), [])
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("refuses one whose stamp I withdrew at this head", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* reviewed(head)
      yield* withdraw(repo, 28, head)

      const error = yield* Effect.flip(dwmc("merge", "28"))

      assert.include(String(error.cause), "withdrawn by hand")
      assert.deepStrictEqual(merges(spawned), [])
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("refuses a stamped pull request GitHub does not call Ready", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* reviewed(head)

      const error = yield* Effect.flip(dwmc("merge", "28"))

      assert.include(String(error.cause), "not Ready")
      assert.include(String(error.cause), "changes are requested")
      assert.deepStrictEqual(merges(spawned), [])
    }).pipe(Effect.provide(machine({ spawned, reviewDecision: "CHANGES_REQUESTED" })), recording(printed))
  })

  it.effect("refuses a draft, however green it is", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* reviewed(head)

      assert.include(String((yield* Effect.flip(dwmc("merge", "28"))).cause), "draft")
      assert.deepStrictEqual(merges(spawned), [])
    }).pipe(Effect.provide(machine({ spawned, draft: true })), recording(printed))
  })

  it.effect("refuses one GitHub says it would not merge", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* reviewed(head)

      const error = yield* Effect.flip(dwmc("merge", "28"))

      assert.include(String(error.cause), "merge conflict")
      assert.deepStrictEqual(merges(spawned), [])
    }).pipe(Effect.provide(machine({ spawned, mergeable: "CONFLICTING" })), recording(printed))
  })

  it.effect("refuses a pull request somebody else opened", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* reviewed(head)

      const error = yield* Effect.flip(dwmc("merge", "28"))

      assert.include(String(error.cause), "not mine")
      assert.deepStrictEqual(merges(spawned), [])
    }).pipe(Effect.provide(machine({ spawned, author: "someone-else" })), recording(printed))
  })

  it.effect("reads its guards live, and not off what the last sweep wrote down", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* reviewed(head)
      // A sweep that saw a green, approved, mergeable head. GitHub has moved on.
      yield* swept({})

      const error = yield* Effect.flip(dwmc("merge", "28"))

      assert.include(String(error.cause), "CI is red")
      assert.deepStrictEqual(merges(spawned), [])
    }).pipe(Effect.provide(machine({ spawned, checks: [failed] })), recording(printed))
  })

  it.effect("merges a head the last sweep knew nothing good about", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* reviewed(head)
      // The other way round: stale facts that would refuse, live ones that merge.
      yield* swept({ checks: "red", mergeable: "conflicting", reviewDecision: "changes-requested" })

      yield* dwmc("merge", "28")

      assert.strictEqual(merges(spawned).length, 1)
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("counts a review run on a head that has gone as no run at all", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* reviewed(gone)

      const error = yield* Effect.flip(dwmc("merge", "28"))

      assert.include(String(error.cause), "no review run on this head")
      assert.deepStrictEqual(merges(spawned), [])
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("prints what gh refused rather than claiming the merge", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* reviewed(head)

      const error = yield* Effect.flip(dwmc("merge", "28"))

      assert.include(String(error.cause), "Protected branch update failed")
      assert.notInclude(printed.join("\n"), "squash-merged")
    }).pipe(
      Effect.provide(machine({ spawned, refusal: "Protected branch update failed for refs/heads/main" })),
      recording(printed)
    )
  })
})
