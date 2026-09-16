#!/usr/bin/env node
// oxlint-disable effecttsgo/strict-effect-provide -- the rule exempts entry points, and this file is the one
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { dwMc, version } from "./cli.ts"
import { ConfigStore } from "./config.ts"
import * as Store from "./store.ts"

// Both stores are built here, for the whole CLI rather than for `init` alone:
// the filesystem store makes its directory as its layer is built, so any run of
// dw-mc leaves the state and configuration directories behind it.
dwMc.pipe(
  Command.run({ version }),
  Effect.provide(
    Layer.provideMerge(
      Layer.mergeAll(ConfigStore.layer, Store.layer),
      NodeServices.layer
    )
  ),
  NodeRuntime.runMain
)
