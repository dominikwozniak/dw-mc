#!/usr/bin/env node
// oxlint-disable effecttsgo/strict-effect-provide -- the rule exempts entry points, and this file is the one
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { dwMc, version } from "./cli.ts"

dwMc.pipe(
  Command.run({ version }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
