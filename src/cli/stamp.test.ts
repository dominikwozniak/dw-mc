import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Console, DateTime, Effect, FileSystem, Layer, Option, Path, Stdio } from "effect"
import { Command } from "effect/unstable/cli"

import type { ConfigFile } from "#adapters/config.ts"
import { ConfigStore, write } from "#adapters/config.ts"
import { layerScripted } from "#adapters/picker.ts"
import { layerFake } from "#adapters/spawner.ts"
import * as Store from "#adapters/store.ts"
import { prKey, storeFor } from "#adapters/store.ts"
import { dwMc, version } from "#cli/cli.ts"
import { Facts } from "#domain/bucket.ts"
import { stampedAmong } from "#domain/stamp.ts"

const repo = "dominikwozniak/dw-mc"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"
const moved = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"

/**
 * Everything the command needs and nothing it spawns: a stamp is computed from
 * what a sweep already wrote down, so a `gh` reached for here would be a bug -
 * a read this command has no business making, and the one place a write could
 * hide (ADR 0001, ADR 0002).
 */
const github = (options: { readonly spawned?: Array<string> | undefined } = {}) =>
  layerFake((command) => {
    options.spawned?.push(command._tag)
    return Effect.die(`stamp.test: nothing is spawned, and ${command._tag} was`)
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

/** The facts the last sweep left behind, as the command reads them back. */
const sweptStore = Effect.flatMap(storeFor("prs", Facts), (store) => store.get(prKey(repo, 28)))

/** The facts the last sweep left behind, of a PR that passed the whole bar. */
const swept = (over: Partial<Facts> = {}) =>
  Effect.flatMap(storeFor("prs", Facts), (store) =>
    store.set(prKey(repo, 28), {
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
    }).pipe(Effect.provide(machine(github())), recording(printed))
  })

  it.effect("says what withholds the stamp, so I never wonder why there is none", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* swept({ checks: "red" })

      yield* run("stamp", "28")

      assert.deepStrictEqual(printed, [`${repo}#28  284d599  not stamped: CI is red`])
    }).pipe(Effect.provide(machine(github())), recording(printed))
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
    }).pipe(Effect.provide(machine(github())), recording(printed))
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
    }).pipe(Effect.provide(machine(github())), recording(printed))
  })

  it.effect("withdraws the stamp the table showed me, and status stops marking it", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* swept()

      yield* run("stamp", "28", "--withdraw")

      assert.deepStrictEqual(printed, [`${repo}#28  284d599  stamp withdrawn, until the head changes`])
      assert.isFalse((yield* stampedAmong([Option.getOrThrow(yield* sweptStore)])).has(prKey(repo, 28)))
    }).pipe(Effect.provide(machine(github())), recording(printed))
  })

  it.effect("reaches nowhere near GitHub, stamping or withdrawing", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)
      yield* swept()

      yield* run("stamp", "28")
      yield* run("stamp", "28", "--withdraw")

      assert.deepStrictEqual(spawned, [])
    }).pipe(Effect.provide(machine(github({ spawned }))), recording(printed))
  })

  it.effect("sends me to a sweep when nothing here knows about the PR yet", () => {
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered(repo)

      const error = yield* Effect.flip(run("stamp", "28"))

      assert.include(String(error.cause), "dw-mc sweep")
    }).pipe(Effect.provide(machine(github())), recording(printed))
  })
})
