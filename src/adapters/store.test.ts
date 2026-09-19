import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, ConfigProvider, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"

import {
  allKeys,
  discard,
  inventory,
  layer,
  layerTest,
  sessionOf,
  stateDirectory,
  storeFor,
  textStoreFor
} from "#adapters/store.ts"

class ReviewRun extends Schema.Class<ReviewRun>("dw-mc/test/ReviewRun")({
  pr: Schema.Int,
  head: Schema.NonEmptyString,
  verdict: Schema.Literals(["clean", "findings"])
}) {}

describe("store", () => {
  it.effect("a schema store round-trips a value under its own namespace", () =>
    Effect.gen(function* () {
      const runs = yield* storeFor("review-run", ReviewRun)
      const run = new ReviewRun({ pr: 7, head: "cafe1234", verdict: "findings" })

      yield* runs.set("7", run)

      assert.deepStrictEqual(yield* runs.get("7"), Option.some(run))

      const stamps = yield* storeFor("stamp", ReviewRun)
      assert.deepStrictEqual(yield* stamps.get("7"), Option.none())

      const raw = yield* KeyValueStore.KeyValueStore
      assert.strictEqual(yield* raw.get("7"), undefined)
    }).pipe(Effect.provide(layerTest))
  )

  it.effect("a text store keeps Markdown as the Markdown it is, in the same namespace", () =>
    Effect.gen(function* () {
      const reports = yield* textStoreFor("review-run")
      const report = "# dominikwozniak/dw-mc#7\n\nOne finding, on src/cli/cli.ts:12.\n"

      yield* reports.set("7.md", report)

      assert.strictEqual(yield* reports.get("7.md"), report)

      const raw = yield* KeyValueStore.KeyValueStore
      assert.strictEqual(yield* raw.get("review-run/7.md"), report)
    }).pipe(Effect.provide(layerTest))
  )

  it.effect("a stored value that no longer matches the schema fails to decode", () =>
    Effect.gen(function* () {
      const raw = yield* KeyValueStore.KeyValueStore
      yield* raw.set("review-run/9", `{"pr":"seven","head":"cafe1234","verdict":"findings"}`)

      const runs = yield* storeFor("review-run", ReviewRun)
      const error = yield* Effect.flip(runs.get("9"))

      assert.strictEqual(error._tag, "SchemaError")
    }).pipe(Effect.provide(layerTest))
  )

  const env = (record: Record<string, string | undefined>) =>
    Effect.provide(Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnvRecord(record)), Path.layer))

  const write = Effect.fnUntraced(function* (run: ReviewRun) {
    const runs = yield* storeFor("review-run", ReviewRun)
    yield* runs.set("7", run)
  })

  const read = Effect.gen(function* () {
    const runs = yield* storeFor("review-run", ReviewRun)
    return yield* runs.get("7")
  })

  const onDisk = (home: string) =>
    Effect.provide(
      Layer.provideMerge(
        layer,
        Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnvRecord({ XDG_STATE_HOME: home })))
      )
    )

  it.effect("the keys the state directory holds are listed as they were written, and nothing else is", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(path.join(home, "dw-mc", "rebases", "dw", "one", "28"), { recursive: true })

      const listed = yield* Effect.gen(function* () {
        yield* write(new ReviewRun({ pr: 7, head: "cafe1234", verdict: "clean" }))
        const reports = yield* textStoreFor("review-run")
        yield* reports.set("dw/one#7@cafe1234.md", "# Clean\n")
        return yield* allKeys
      }).pipe(onDisk(home))

      assert.deepStrictEqual(listed.toSorted(), ["review-run/7", "review-run/dw/one#7@cafe1234.md"])
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("a file no key could have been written as is not listed, rather than failing the list", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(path.join(home, "dw-mc"), { recursive: true })
      yield* fs.writeFileString(path.join(home, "dw-mc", "notes%zz"), "mine\n")

      const listed = yield* Effect.gen(function* () {
        yield* write(new ReviewRun({ pr: 7, head: "cafe1234", verdict: "clean" }))
        return yield* allKeys
      }).pipe(onDisk(home))

      assert.deepStrictEqual(listed, ["review-run/7"])
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("the store a test builds lists what it holds, and forgets what it removed", () =>
    Effect.gen(function* () {
      const raw = yield* KeyValueStore.KeyValueStore
      yield* raw.set("runs/dw/one#7", "{}")
      yield* raw.set("stamps/dw/one#7", "{}")
      yield* raw.remove("runs/dw/one#7")

      assert.deepStrictEqual(yield* allKeys, ["stamps/dw/one#7"])
    }).pipe(Effect.provide(layerTest))
  )

  it.effect("the state directory sits under XDG_STATE_HOME when it is set", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* stateDirectory, "/var/state/dw-mc")
    }).pipe(env({ XDG_STATE_HOME: "/var/state", HOME: "/home/dw" }))
  )

  it.effect("the state directory falls back to the XDG default under HOME", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* stateDirectory, "/home/dw/.local/state/dw-mc")
    }).pipe(env({ HOME: "/home/dw" }))
  )

  it.effect("the filesystem layer keeps a value across two stores over one directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const run = new ReviewRun({ pr: 7, head: "cafe1234", verdict: "clean" })

      yield* write(run).pipe(onDisk(home))

      assert.deepStrictEqual(yield* read.pipe(onDisk(home)), Option.some(run))
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("providing the filesystem layer creates the state directory even unused", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()

      yield* Effect.void.pipe(onDisk(home))

      assert.isTrue(yield* fs.exists(path.join(home, "dw-mc")))
    }).pipe(Effect.provide(NodeServices.layer))
  )

  /** A state directory with a clone, a review worktree, a fix worktree and a record. */
  const laidOut = Effect.fnUntraced(function* (state: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const put = Effect.fnUntraced(function* (where: ReadonlyArray<string>, contents: string) {
      const file = path.join(state, ...where)
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(file, contents)
    })

    yield* put(["repos", "dw", "one.git", "HEAD"], "ref: refs/heads/main\n")
    yield* put(["worktrees", "dw", "one", "28", "README.md"], "cut for a review run\n")
    yield* put(["fixes", "dw", "one", "28", "README.md"], "cut for a fix session\n")
    yield* put(["repos", "dw", "two.git", "HEAD"], "ref: refs/heads/main\n")
    yield* put(["prs%2Fdw%2Fone%2328"], `{"number":28}`)
    yield* put(["runs%2Fdw%2Fone%2328.md"], "# One finding\n")
  })

  const inventoryOf = (state: string) =>
    inventory.pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              XDG_STATE_HOME: state
            })
          )
        )
      )
    )

  it.effect("the inventory names the clones, the checkouts and the records it finds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const state = path.join(home, "dw-mc")
      yield* laidOut(state)

      const found = yield* inventoryOf(home)

      assert.strictEqual(found.directory, state)
      assert.deepStrictEqual(
        found.clones.map((one) => one.repo),
        ["dw/one", "dw/two"]
      )
      assert.deepStrictEqual(
        found.cuttings.map((one) => `${one.cut}/${one.repo}#${one.number}`),
        ["worktrees/dw/one#28", "fixes/dw/one#28"]
      )
      assert.strictEqual(found.records.keys, 2)
      assert.isTrue(ByteSize.toBigInt(found.records.size) > BigInt(0))
      assert.isTrue(ByteSize.toBigInt(found.clones[0]?.size ?? ByteSize.bytes(0)) > BigInt(0))
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("the inventory of a machine that has run nothing is empty rather than an error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()

      const found = yield* inventoryOf(home)

      assert.deepStrictEqual(found.clones, [])
      assert.deepStrictEqual(found.cuttings, [])
      assert.strictEqual(found.records.keys, 0)
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("what is discarded is gone, and discarding it twice is not an error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const state = path.join(home, "dw-mc")
      yield* laidOut(state)
      const clone = path.join(state, "repos", "dw", "one.git")

      yield* discard(clone)
      yield* discard(clone)

      assert.isFalse(yield* fs.exists(clone))
      assert.isTrue(yield* fs.exists(path.join(state, "repos", "dw", "two.git")))
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it("a review worktree stands for no session, where the two session directories do", () => {
    assert.strictEqual(sessionOf("worktrees"), undefined)
    assert.strictEqual(sessionOf("fixes"), "fix")
    assert.strictEqual(sessionOf("rebases"), "rebase")
  })

  it.effect("the in-memory layer forgets between builds, where the one on disk remembers", () =>
    Effect.gen(function* () {
      const run = new ReviewRun({ pr: 7, head: "cafe1234", verdict: "clean" })

      yield* write(run).pipe(Effect.provide(layerTest))

      assert.deepStrictEqual(yield* read.pipe(Effect.provide(layerTest)), Option.none())
    })
  )
})
