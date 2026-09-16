import type { Config, Path } from "effect"
import { Effect, Layer, Schema } from "effect"
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

/** The state directory on disk. */
export const layer = Layer.unwrap(Effect.map(stateDirectory, (directory) => KeyValueStore.layerFileSystem(directory)))

/** A store that lives only as long as the test that builds it. */
export const layerTest: Layer.Layer<KeyValueStore.KeyValueStore> = KeyValueStore.layerMemory
