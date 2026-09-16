import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Console, DateTime, Effect, FileSystem, Layer, Path, Stdio } from "effect"
import { Command } from "effect/unstable/cli"

import type { ConfigFile } from "#adapters/config.ts"
import { ConfigStore, write } from "#adapters/config.ts"
import { layerScripted } from "#adapters/picker.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"
import * as Store from "#adapters/store.ts"
import { storeFor } from "#adapters/store.ts"
import { dwMc, version } from "#cli/cli.ts"
import { Facts, factsKey } from "#domain/bucket.ts"

const repo = "dominikwozniak/dw-mc"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"
const moved = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"

/**
 * A `gh` that answers the one read this command makes, and dies on anything
 * else: a stamp is mine alone, so a write here would be a bug (ADR 0002).
 */
const github = (options: { readonly spawned?: Array<string> | undefined; readonly head?: string | undefined }) =>
  layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("stamp.test: the fake was handed a piped command")
    }
    const argv = command.args.join(" ")
    options.spawned?.push(`${command.command} ${argv}`)

    if (/^pr view 28 --repo \S+ --json \S+$/.test(argv)) {
      return Effect.succeed(
        fakeHandle({
          stdout: JSON.stringify({
            number: 28,
            title: "feat: the computed stamp",
            url: `https://github.com/${repo}/pull/28`,
            isDraft: false,
            headRefOid: options.head ?? head,
            mergeable: "MERGEABLE",
            reviewDecision: "",
            statusCheckRollup: []
          })
        })
      )
    }
    return Effect.die(`stamp.test: nothing stubbed for '${command.command} ${argv}'`)
  })

const machine = (spawner: ReturnType<typeof github>) =>
  Layer.provideMerge(
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

/** The facts the last sweep left behind, of a PR that passed the whole bar. */
const swept = (over: Partial<Facts> = {}) =>
  Effect.flatMap(storeFor("prs", Facts), (store) =>
    store.set(factsKey(repo, 28), {
      repo,
      number: 28,
      title: "feat: the computed stamp",
      url: `https://github.com/${repo}/pull/28`,
      draft: false,
      head,
      mergeable: "mergeable",
      reviewDecision: "none",
      checks: "green",
      ciFlaky: null,
      newestHumanCommentAt: null,
      myLastCommentAt: null,
      myLastCommitAt: DateTime.makeUnsafe("2026-09-16T10:05:57Z"),
      reviewRunHead: head,
      blockingFindings: 0,
      ...over
    })
  )

describe("dw-mc stamp", () => {
  it.effect("says a PR that passed the bar is stamped", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* swept()

      yield* run("stamp", "28")

      assert.deepStrictEqual(printed, [`${repo}#28  284d599  stamped`])
    }).pipe(Effect.provide(machine(github({}))), recording(printed))
  })

  it.effect("says what withholds the stamp, so I never wonder why there is none", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* swept({ checks: "red" })

      yield* run("stamp", "28")

      assert.deepStrictEqual(printed, [`${repo}#28  284d599  not stamped: CI is red`])
    }).pipe(Effect.provide(machine(github({}))), recording(printed))
  })

  it.effect("takes the stamp off by hand, and leaves it off while the head stands", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* swept()

      yield* run("stamp", "28", "--withdraw")
      yield* run("stamp", "28")

      assert.deepStrictEqual(printed, [
        `${repo}#28  284d599  stamp withdrawn, until the head changes`,
        `${repo}#28  284d599  not stamped: withdrawn by hand`
      ])
    }).pipe(Effect.provide(machine(github({}))), recording(printed))
  })

  it.effect("computes the stamp again once the head has moved past the withdrawal", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* swept()
      yield* run("stamp", "28", "--withdraw")

      yield* swept({ head: moved, reviewRunHead: moved })
      yield* run("stamp", "28")

      assert.deepStrictEqual(printed.at(-1), `${repo}#28  9f2b0c1  stamped`)
    }).pipe(Effect.provide(machine(github({}))), recording(printed))
  })

  it.effect("withdraws against the head GitHub has now, not the one the sweep saw", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* swept()

      yield* run("stamp", "28", "--withdraw")

      assert.deepStrictEqual(printed, [`${repo}#28  9f2b0c1  stamp withdrawn, until the head changes`])
    }).pipe(Effect.provide(machine(github({ head: moved }))), recording(printed))
  })

  it.effect("writes nothing to GitHub, stamping or withdrawing", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* swept()

      yield* run("stamp", "28")
      yield* run("stamp", "28", "--withdraw")

      assert.deepStrictEqual(spawned, [
        "gh pr view 28 --repo dominikwozniak/dw-mc --json " +
          "number,title,url,isDraft,headRefOid,mergeable,reviewDecision,statusCheckRollup"
      ])
    }).pipe(Effect.provide(machine(github({ spawned }))), recording(printed))
  })

  it.effect("sends me to a sweep when nothing here knows about the PR yet", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      const error = yield* Effect.flip(run("stamp", "28"))

      assert.include(String(error.cause), "dw-mc sweep")
    }).pipe(Effect.provide(machine(github({}))), recording(printed))
  })
})
