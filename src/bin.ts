#!/usr/bin/env node
// oxlint-disable effecttsgo/strict-effect-provide -- the rule exempts entry points, and this file is the one
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { dwMc, version } from "./cli.ts"
import { ConfigStore } from "./config.ts"
import * as Store from "./store.ts"

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
