import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { ConfigStore } from "#adapters/config.ts"
import { recording } from "#adapters/picker.ts"
import { layerStubbed } from "#adapters/spawner.ts"
import { dwMc, machineOf, run, version } from "#cli/cli.ts"

/**
 * How each command that reads the configuration file is run, and why the rest
 * are not. A command added to the CLI fails the coverage test until it is named
 * in one of the two.
 */
const readsTheFile: Record<string, ReadonlyArray<string>> = {
  review: ["review", "28"],
  comments: ["comments", "28"],
  findings: ["findings", "28"],
  fix: ["fix", "28"],
  rebase: ["rebase", "28"],
  rerun: ["rerun", "28"],
  resolve: ["resolve", "28"],
  merge: ["merge", "28"],
  forget: ["forget", "28"],
  sweep: ["sweep"],
  status: ["status"],
  stamp: ["stamp", "28"]
}

const skipped: Record<string, string> = {
  init: "asks gh whether it is logged in first, and its own test covers the file",
  cleanup: "never reads the file",
  uninstall: "removes the file without reading it"
}

describe("dw-mc cli", () => {
  it.effect("exposes the root command under the binary name", () =>
    Effect.gen(function* () {
      assert.strictEqual(dwMc.name, "dw-mc")
      assert.strictEqual(version, "0.0.0")
    })
  )

  it("names every command as one that reads the configuration file or one that does not", () => {
    const commands = dwMc.subcommands.flatMap((group) => group.commands).map((sub) => sub.name)

    assert.deepStrictEqual(commands.toSorted(), [...Object.keys(readsTheFile), ...Object.keys(skipped)].toSorted())
  })

  for (const argv of [...Object.values(readsTheFile), []]) {
    it.effect(`dw-mc ${argv.join(" ") || "(the picker)"} says what is wrong with a configuration file that is`, () =>
      Effect.gen(function* () {
        const config = yield* ConfigStore
        yield* config.store.set("config.yaml", "defaults:\n  review:\n    commnad: /code-review\n")

        const error = yield* Effect.flip(run(...argv))

        assert.strictEqual(error._tag, "UserError")
        assert.include(error.message, "/home/dw/.config/dw-mc/config.yaml")
        assert.include(error.message, "commnad")
      }).pipe(Effect.provide(machineOf({ spawner: layerStubbed({ stubs: [] }) })), recording([]))
    )
  }
})
