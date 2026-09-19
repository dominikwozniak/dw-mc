import type { Config } from "effect"
import { ByteSize, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"

import { xdgDirectory } from "#adapters/xdg.ts"

/**
 * Where the tool keeps its state: `$XDG_STATE_HOME/dw-mc`, or
 * `$HOME/.local/state/dw-mc` when XDG says nothing.
 */
export const stateDirectory: Effect.Effect<string, Config.ConfigError, Path.Path> = xdgDirectory(
  "XDG_STATE_HOME",
  ".local",
  "state"
)

/**
 * How the state directory names one pull request, whichever namespace it is in.
 *
 * The facts a sweep wrote and the stamp I withdrew are the same pull request
 * under two namespaces, so the key format is spelled once here rather than in
 * each of them.
 */
export const prKey = (repo: string, number: number): string => `${repo}#${number}`

/**
 * A schema-typed view of the store, with every key under `namespace`.
 *
 * Tracked PRs, review runs and stamps share one directory, so the namespace is
 * what keeps them apart. Note that `clear`, `size` and `isEmpty` are not
 * namespaced - they still see the whole store.
 */
export const storeFor = Effect.fn("store.storeFor")(function* <S extends Schema.Constraint>(
  namespace: string,
  schema: S
) {
  const store = yield* KeyValueStore.KeyValueStore
  return KeyValueStore.toSchemaStore(KeyValueStore.prefix(store, `${namespace}/`), schema)
})

/**
 * The same namespace, kept as text rather than as JSON.
 *
 * A review run's report is Markdown, and the state directory is meant to hold
 * what I can open: through a schema store the same report would be one long
 * JSON string with its newlines escaped.
 */
export const textStoreFor = Effect.fn("store.textStoreFor")(function* (namespace: string) {
  const store = yield* KeyValueStore.KeyValueStore
  return KeyValueStore.prefix(store, `${namespace}/`)
})

/**
 * What a store holds under a key, and nothing where it holds nothing this
 * version can read.
 *
 * A record this version cannot read is one another version of it wrote, and the
 * state directory is a cache of work that can be done again ([ADR
 * 0010](../../docs/adr/0010-configuration-that-cannot-be-read.md)): forgetting a
 * record costs that work once, where failing here would cost the command I
 * asked for. Every read of the tool's own records goes through this, so the
 * bargain is struck once rather than at each of them.
 */
export const remembered = <A, E, R>(
  read: Effect.Effect<Option.Option<A>, E, R>
): Effect.Effect<Option.Option<A>, never, R> => Effect.orElseSucceed(read, () => Option.none<A>())

/**
 * Every key the state directory holds, whichever namespace it sits in.
 *
 * A key/value store answers about a key it is given and never lists one, and
 * forgetting a pull request needs the list: a review run is kept under the head
 * it read, and nothing on hand names every head a pull request was reviewed at.
 */
export class Keys extends Context.Service<
  Keys,
  { readonly all: Effect.Effect<ReadonlyArray<string>, KeyValueStore.KeyValueStoreError> }
>()("dw-mc/store/Keys") {}

/**
 * The keys a file store over `directory` holds: one file each, named by the
 * percent-encoded key.
 *
 * The clones and the checkouts sit beside them as directories, and none of
 * them is a key.
 */
const keysOnDisk = (directory: string) =>
  Layer.effect(
    Keys,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directories = new Set<string>([clonesIn, ...cuts])
      return {
        all: fs.readDirectory(directory).pipe(
          Effect.map((entries) =>
            entries.filter((entry) => !directories.has(entry)).map((entry) => decodeURIComponent(entry))
          ),
          Effect.mapError(
            (cause) =>
              new KeyValueStore.KeyValueStoreError({ method: "keys", message: "Unable to list the keys", cause })
          )
        )
      }
    })
  )

/** The state directory on disk. */
export const layer = Layer.unwrap(
  Effect.map(stateDirectory, (directory) =>
    Layer.merge(KeyValueStore.layerFileSystem(directory), keysOnDisk(directory))
  )
)

/**
 * A store that lives only as long as the test that builds it.
 *
 * It is the in-memory store with a note of every key it was handed, because
 * the store keeps its map to itself.
 */
export const layerTest: Layer.Layer<KeyValueStore.KeyValueStore | Keys> = Layer.effectContext(
  Effect.gen(function* () {
    const inner = yield* KeyValueStore.KeyValueStore
    const held = new Set<string>()
    const store = KeyValueStore.make({
      ...inner,
      set: (key, value) => Effect.tap(inner.set(key, value), () => Effect.sync(() => held.add(key))),
      remove: (key) => Effect.tap(inner.remove(key), () => Effect.sync(() => held.delete(key))),
      clear: Effect.tap(inner.clear, () => Effect.sync(() => held.clear()))
    })
    return Context.make(KeyValueStore.KeyValueStore, store).pipe(
      Context.add(Keys, { all: Effect.sync(() => [...held]) })
    )
  })
).pipe(Layer.provide(KeyValueStore.layerMemory))

/** The three directories the tool cuts a checkout into, under the state directory. */
export const cuts = ["worktrees", "fixes", "rebases"] as const

/** Which of them one checkout sits in, which is also what it was cut for. */
export type Cut = (typeof cuts)[number]

/** What a standing worktree is for, which names its branch and the directory it is cut in. */
export type Session = "fix" | "rebase"

/** Where each kind of session's worktrees live under the state directory. */
export const under = { fix: "fixes", rebase: "rebases" } as const

/**
 * Which session a checkout belongs to, and nothing where it belongs to none.
 *
 * `worktrees` is the review run's own, cut and taken down inside one run, so it
 * stands for no session at all: that is the difference every command that
 * removes something turns on.
 */
export const sessionOf = (cut: Cut): Session | undefined =>
  (({ fixes: "fix", rebases: "rebase", worktrees: undefined }) as const)[cut]

/** Where the bare clones sit, under the state directory. */
export const clonesIn = "repos"

// The four names below are the map of the state directory, and the walks
// further down read that same map back off the disk. A command that cuts a
// worktree and a command that takes one away have to arrive at the same path to
// the byte, and a name spelled on both sides of that is two names that drift.
//
// None of them reaches the network, which is the whole point of them being
// names and not reads: `git.holding` asks where a session sits before it
// removes anything, and a machine that is offline has to be told what it holds
// rather than be made to clone to find out.

/** What a bare clone's directory is called, and what tells one from anything beside it. */
const bare = ".git"

/** Where the tool keeps one repository's bare clone. */
export const cloneAt = Effect.fn("store.cloneAt")(function* (repo: string) {
  const path = yield* Path.Path
  return path.join(yield* stateDirectory, clonesIn, `${repo}${bare}`)
})

/** Where one pull request's checkout goes, under the cut it was made for. */
export const cutAt = Effect.fn("store.cutAt")(function* (cut: Cut, repo: string, number: number) {
  const path = yield* Path.Path
  return path.join(yield* stateDirectory, cut, repo, String(number))
})

/**
 * What the branch a standing session works on is called, inside that clone.
 *
 * It carries the session's name because a fix session and a session on a
 * conflict stand at the same time on the same pull request, and one branch
 * between them would be one holding the other's commits.
 */
export const sessionBranch = (session: Session, number: number): string => `dw-mc/${session}/${number}`

/**
 * What the ref a clone keeps one pull request's head under is called.
 *
 * A cut fetches it and a removal reads it back without fetching, so the two
 * have to spell it the same or a session would be asked about a ref nothing
 * ever wrote.
 */
export const pullRef = (number: number): string => `refs/dw-mc/pr/${number}`

/** A directory under the state directory, and what everything below it weighs. */
export interface Weighed {
  readonly directory: string
  readonly size: ByteSize.ByteSize
}

/** One repository's bare clone. */
export interface Clone extends Weighed {
  readonly repo: string
}

/** One checkout the tool cut, named by the pull request it stands on. */
export interface Cutting extends Weighed {
  readonly cut: Cut
  readonly repo: string
  readonly number: number
}

/**
 * Everything the state directory holds, read as directories rather than as
 * keys.
 *
 * The key/value seam is the wrong window for this: a store answers about the
 * keys of one namespace, and what a cleanup is about is the clones and the
 * checkouts, which no namespace ever sees. So this reads the directory itself,
 * and `records` is the one line it has to say about the keys - their number and
 * their weight together, because which pull request a key belongs to is the
 * question `Keys` and forgetting answer, and not this one.
 */
export interface Inventory {
  readonly directory: string
  readonly clones: ReadonlyArray<Clone>
  readonly cuttings: ReadonlyArray<Cutting>
  readonly records: { readonly keys: number; readonly size: ByteSize.ByteSize }
}

/** What a directory holds, or nothing at all where it is not there. */
const entriesOf = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* Effect.orElseSucceed(fs.readDirectory(directory), (): ReadonlyArray<string> => [])
})

/**
 * What the entries named under `directory` weigh together.
 *
 * A file that is gone by the time it is asked about weighs nothing rather than
 * failing the walk: the directory is being read while the tool may be writing
 * to it, and a size on a screen is worth less than the listing it sits in.
 */
const weightOf = Effect.fnUntraced(function* (directory: string, entries: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const sizes = yield* Effect.forEach(
    entries,
    (entry) =>
      Effect.orElseSucceed(
        Effect.map(fs.stat(path.join(directory, entry)), (info) => ByteSize.toBigInt(info.size)),
        () => BigInt(0)
      ),
    { concurrency: 16 }
  )
  return ByteSize.bytes(sizes.reduce((total, size) => total + size, BigInt(0)))
})

/** What `directory` and everything below it weighs. */
export const weigh = Effect.fn("store.weigh")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* Effect.orElseSucceed(
    fs.readDirectory(directory, { recursive: true }),
    (): ReadonlyArray<string> => []
  )
  return yield* weightOf(directory, entries)
})

/** The bare clones, named by the `owner/repo` the two directory levels spell. */
const clonesOf = Effect.fnUntraced(function* (state: string) {
  const path = yield* Path.Path
  const root = path.join(state, clonesIn)
  const clones: Array<Clone> = []

  for (const owner of yield* entriesOf(root)) {
    for (const name of yield* entriesOf(path.join(root, owner))) {
      if (!name.endsWith(bare)) {
        continue
      }
      const directory = path.join(root, owner, name)
      clones.push({ repo: `${owner}/${name.slice(0, -bare.length)}`, directory, size: yield* weigh(directory) })
    }
  }
  return clones
})

/** The checkouts, named by the `owner/repo/number` the three directory levels spell. */
const cuttingsOf = Effect.fnUntraced(function* (state: string) {
  const path = yield* Path.Path
  const cuttings: Array<Cutting> = []

  for (const cut of cuts) {
    for (const owner of yield* entriesOf(path.join(state, cut))) {
      for (const name of yield* entriesOf(path.join(state, cut, owner))) {
        for (const number of yield* entriesOf(path.join(state, cut, owner, name))) {
          if (!/^\d+$/.test(number)) {
            continue
          }
          const directory = path.join(state, cut, owner, name, number)
          cuttings.push({
            cut,
            repo: `${owner}/${name}`,
            number: Number(number),
            directory,
            size: yield* weigh(directory)
          })
        }
      }
    }
  }
  return cuttings
})

/** Everything the state directory holds, in one pass over the disk. */
export const inventory: Effect.Effect<Inventory, Config.ConfigError, FileSystem.FileSystem | Path.Path> = Effect.gen(
  function* () {
    const directory = yield* stateDirectory

    const directories = new Set<string>([clonesIn, ...cuts])
    const top = yield* entriesOf(directory)
    const keys = top.filter((entry) => !directories.has(entry))

    return {
      directory,
      clones: yield* clonesOf(directory),
      cuttings: yield* cuttingsOf(directory),
      records: { keys: keys.length, size: yield* weightOf(directory, keys) }
    }
  }
).pipe(Effect.withSpan("store.inventory"))

/**
 * Takes a directory and everything below it off the disk.
 *
 * A path that is not there is the ordinary case rather than a failure: two
 * commands may ask for the same thing gone, and the second one is right about
 * the outcome.
 */
export const discard = Effect.fn("store.discard")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(directory, { recursive: true, force: true })
})

/**
 * Removes what discarding left empty above `directory`, and stops at `upTo`.
 *
 * The layout spells an owner and a repository as directories, so taking one
 * clone away leaves the owner's directory standing with nothing in it. It is a
 * few bytes, and it is also a listing that says the tool still keeps something
 * there when it does not.
 *
 * A directory with anything left in it ends the walk rather than being emptied:
 * what is beside the thing removed belongs to something else.
 */
export const tidy = Effect.fn("store.tidy")(function* (directory: string, upTo: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  let at = path.dirname(directory)
  while (at !== upTo && at.startsWith(upTo)) {
    const entries = yield* Effect.orElseSucceed(fs.readDirectory(at), (): ReadonlyArray<string> => ["stop"])
    if (entries.length > 0) {
      return
    }
    // Recursive over a directory the line above found empty, because that is
    // what removing a directory at all takes; it can still take nothing away.
    yield* Effect.ignore(fs.remove(at, { recursive: true }))
    at = path.dirname(at)
  }
})
