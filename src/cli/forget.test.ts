import { NodeFileSystem } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"

import type { ConfigFile } from "#adapters/config.ts"
import { write } from "#adapters/config.ts"
import { recording } from "#adapters/picker.ts"
import { layerStubbed, vectorOf } from "#adapters/spawner.ts"
import * as Store from "#adapters/store.ts"
import { machineOf, run } from "#cli/cli.ts"

const repo = "dominikwozniak/dw-mc"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"

/** A machine that spawns nothing, and records it if anything tries. */
const machine = (options: { readonly spawned: Array<string>; readonly home?: string | undefined }) =>
  machineOf({
    ...(options.home === undefined
      ? {}
      : {
          env: { HOME: options.home, XDG_STATE_HOME: options.home, XDG_CONFIG_HOME: options.home },
          fileSystem: NodeFileSystem.layer
        }),
    spawner: layerStubbed({ onSpawn: (command) => options.spawned.push(vectorOf(command)), stubs: [] })
  })

const registered = write({ repos: { [repo]: {} } } satisfies ConfigFile)

/** One key in every namespace a pull request leaves behind, reports included. */
const kept = (number: number) => [
  `prs/${repo}#${number}`,
  `runs/${repo}#${number}@${head}`,
  `runs/${repo}#${number}@${head}.md`,
  `runs/${repo}#${number}@latest`,
  `stamps/${repo}#${number}`,
  `reruns/${repo}#${number}`,
  `rebases/${repo}#${number}`,
  `acknowledgements/${repo}#${number}`,
  `watermarks/${repo}#${number}`
]

const keep = Effect.fnUntraced(function* (keys: ReadonlyArray<string>) {
  const raw = yield* KeyValueStore.KeyValueStore
  yield* Effect.forEach(keys, (key) => raw.set(key, "{}"), { discard: true })
})

const held = Effect.gen(function* () {
  return (yield* Store.allKeys).toSorted()
})

describe("dw-mc forget", () => {
  it.effect("forgets the pull request in every namespace, and leaves the one beside it", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered
      yield* keep([...kept(28), ...kept(29)])

      yield* run("forget", "28")

      assert.deepStrictEqual(yield* held, kept(29).toSorted())
      assert.deepStrictEqual(printed, [`Forgot ${repo}#28: 9 records.`])
      assert.deepStrictEqual(spawned, [])
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("says there was nothing to forget, and is not an error", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      yield* registered

      yield* run("forget", "28")

      assert.deepStrictEqual(printed, [`Nothing is kept about ${repo}#28.`])
    }).pipe(Effect.provide(machine({ spawned })), recording(printed))
  })

  it.effect("leaves a session's worktree standing, and says it is there", () => {
    const spawned: Array<string> = []
    const printed: Array<string> = []

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const fix = path.join(home, "dw-mc", "fixes", repo, "28")
      const other = path.join(home, "dw-mc", "rebases", repo, "29")
      yield* fs.makeDirectory(fix, { recursive: true })
      yield* fs.writeFileString(path.join(fix, "README.md"), "committed in a fix session\n")
      yield* fs.makeDirectory(other, { recursive: true })

      yield* Effect.gen(function* () {
        yield* registered
        yield* keep(kept(28))
        yield* run("forget", "28")
      }).pipe(Effect.provide(machine({ spawned, home })), recording(printed))

      assert.isTrue(yield* fs.exists(path.join(fix, "README.md")))
      const said = printed.join("\n")
      assert.include(said, `fixes/${repo}/28`)
      assert.include(said, "a fix session's worktree, on dw-mc/fix/28")
      assert.notInclude(said, `rebases/${repo}/29`)
      assert.notInclude(said, "deleted")
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer)))
  })
})
