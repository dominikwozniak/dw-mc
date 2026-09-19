#!/usr/bin/env node
// oxlint-disable effecttsgo/strict-effect-provide -- the rule exempts entry points, and this file is the one
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"

import { ConfigStore } from "#adapters/config.ts"
import * as Paint from "#adapters/paint.ts"
import * as Store from "#adapters/store.ts"
import { dwMc, version } from "#cli/cli.ts"
import * as Header from "#cli/header.ts"

// Both stores are built here, for the whole CLI rather than for `init` alone:
// the filesystem store makes its directory as its layer is built, so any run of
// dw-mc leaves the state and configuration directories behind it. The header
// reads the configuration for the help screen, so it stands on the one store.
dwMc.pipe(
  Command.run({ version }),
  Effect.provide(
    Layer.provideMerge(
      Layer.mergeAll(Layer.provideMerge(Header.layer, ConfigStore.layer), Store.layer, Paint.layer),
      NodeServices.layer
    )
  ),
  NodeRuntime.runMain
)
