import { NodeFileSystem } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"

import { recording } from "#adapters/picker.ts"
import { layerStubbed } from "#adapters/spawner.ts"
import { dwMc, machineOf, run } from "#cli/cli.ts"

/** The flags a command's help screen lists under FLAGS, leaving out the global ones every command shares. */
const helpFlags = Effect.fnUntraced(function* (command: string) {
  const printed: Array<string> = []
  yield* run(command, "--help").pipe(
    Effect.ignoreCause,
    recording(printed),
    Effect.provide(machineOf({ spawner: layerStubbed({ stubs: [] }) }))
  )
  const lines = printed.join("\n").split("\n")
  const start = lines.indexOf("FLAGS")
  if (start === -1) {
    return []
  }
  const end = lines.findIndex((line, index) => index > start && line.trim() === "")
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .flatMap((line) => /^\s+(--[\w-]+)/.exec(line)?.[1] ?? [])
    .toSorted()
})

/** The flag rows under each `## dw-mc <command>` heading of `docs/cli.md`. */
const documentedFlags = (text: string): ReadonlyMap<string, ReadonlyArray<string>> => {
  const flags = new Map<string, Array<string>>()
  let command: string | undefined
  for (const line of text.split("\n")) {
    const heading = /^## `dw-mc ([\w-]+)/.exec(line)
    if (heading !== null) {
      command = heading[1]
      flags.set(command, [])
      continue
    }
    if (line.startsWith("## ")) {
      command = undefined
      continue
    }
    const row = /^\| `(--[\w-]+)`/.exec(line)
    if (row !== null && command !== undefined) {
      flags.get(command)?.push(row[1] ?? "")
    }
  }
  return flags
}

describe("docs/cli.md", () => {
  it.effect("lists exactly the flags every command takes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const documented = documentedFlags(yield* fs.readFileString(path.join(import.meta.dirname, "../../docs/cli.md")))

      for (const command of dwMc.subcommands.flatMap((group) => group.commands).map((sub) => sub.name)) {
        const listed = documented.get(command)
        assert.isDefined(listed, `docs/cli.md has a section for dw-mc ${command}`)
        assert.deepStrictEqual(
          (listed ?? []).toSorted(),
          yield* helpFlags(command),
          `docs/cli.md lists the flags dw-mc ${command} --help does`
        )
      }
    }).pipe(Effect.provide([NodeFileSystem.layer, Path.layer]))
  )
})
