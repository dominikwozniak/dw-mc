import { Config, Effect, Layer, Option, Path, Schema } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"

/**
 * Where the tool keeps its state: `$XDG_STATE_HOME/dw-mc`, or
 * `$HOME/.local/state/dw-mc` when XDG says nothing.
 */
export const stateDirectory = Effect.fn("store.stateDirectory")(function*() {
  const path = yield* Path.Path
  const xdg = yield* Config.String("XDG_STATE_HOME").pipe(Config.option)
  if (Option.isSome(xdg)) {
    return path.join(xdg.value, "dw-mc")
  }
  const home = yield* Config.String("HOME")
  return path.join(home, ".local", "state", "dw-mc")
})

/**
 * A schema-typed view of the store, with every key under `namespace`.
 *
 * Tracked PRs, review runs and stamps share one directory, so the namespace is
 * what keeps them apart. Note that `clear`, `size` and `isEmpty` are not
 * namespaced - they still see the whole store.
 */
export const storeFor = Effect.fn("store.storeFor")(function*<S extends Schema.Constraint>(
  namespace: string,
  schema: S
) {
  const store = yield* KeyValueStore.KeyValueStore
  return KeyValueStore.toSchemaStore(KeyValueStore.prefix(store, `${namespace}/`), schema)
})

/** The state directory on disk. */
export const layer = Layer.unwrap(
  Effect.map(stateDirectory(), (directory) => KeyValueStore.layerFileSystem(directory))
)

/** A store that lives only as long as the test that builds it. */
export const layerTest: Layer.Layer<KeyValueStore.KeyValueStore> = KeyValueStore.layerMemory
