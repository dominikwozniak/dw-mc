#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { dwMc, version } from "./cli.ts"

dwMc.pipe(
  Command.run({ version }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
