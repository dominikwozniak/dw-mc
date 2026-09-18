import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Path, Stdio } from "effect"

import { ConfigStore } from "#adapters/config.ts"
import { layerScripted, recording } from "#adapters/picker.ts"
import { layerStubbed } from "#adapters/spawner.ts"
import * as Store from "#adapters/store.ts"
import { projectUrl, run, version } from "#cli/cli.ts"
import * as Header from "#cli/header.ts"

/** The machine a help screen is printed on: a terminal or a pipe, with or without `NO_COLOR`. */
interface Machine {
  readonly terminal?: boolean | undefined
  readonly env?: Record<string, string> | undefined
}

/**
 * Runs the CLI over `argv` and gives back the lines it printed.
 *
 * Everything it runs on is in here: nothing is spawned, nothing is asked, and
 * the header layer is the one the entry point provides.
 */
const screen = Effect.fnUntraced(function* (argv: ReadonlyArray<string>, machine: Machine = {}) {
  const printed: Array<string> = []

  // A screen is printed whether the run succeeds or not: `dw-mc bogus` prints
  // one on its way to failing, and that screen is what a test here reads.
  //
  // The stack is assembled here rather than taken from `machineOf`, because
  // this is not a command running: it is the help screen, which needs the
  // header's formatter and a stdout that says whether it is a terminal.
  yield* run(...argv).pipe(
    Effect.ignoreCause,
    recording(printed),
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(ConfigStore.layerTest, Store.layerTest, Header.layer),
        Layer.mergeAll(
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/home/dw", ...machine.env })),
          FileSystem.layerNoop({}),
          Path.layer,
          Stdio.layerTest({ stdoutIsTerminal: Effect.succeed(machine.terminal ?? false) }),
          layerStubbed({ stubs: [] }),
          layerScripted([])
        )
      )
    )
  )

  return printed.join("\n").split("\n")
})

/** The lines above `DESCRIPTION`, which is where the header sits. */
const above = (lines: ReadonlyArray<string>) => {
  const description = lines.findIndex((line) => line.includes("DESCRIPTION"))
  assert.isAbove(description, -1, "the screen has a DESCRIPTION section")
  return lines.slice(0, description)
}

/** A line of the logo says nothing; it is drawn. */
const drawn = /^[ _|\\/()]+$/

describe("the header", () => {
  it.effect("opens the root help screen with a logo, the version and the project", () =>
    Effect.gen(function* () {
      const header = above(yield* screen(["--help"]))

      assert.match(header[0] ?? "", drawn, "the first line is drawn, not written")
      assert.isTrue(
        header.some((line) => line.includes(version)),
        `the header says ${version}`
      )
      assert.isTrue(
        header.some((line) => line.includes(projectUrl)),
        `the header says ${projectUrl}`
      )
    })
  )

  it.effect("leaves the rest of the root help screen alone", () =>
    Effect.gen(function* () {
      const lines = yield* screen(["--help"])

      for (const section of ["DESCRIPTION", "USAGE", "GLOBAL FLAGS", "SUBCOMMANDS"]) {
        assert.include(lines, section)
      }
      assert.isTrue(
        lines.some((line) => line.trimStart().startsWith("status")),
        "every subcommand is still listed"
      )
    })
  )

  it.effect("introduces the tool the same way under --version", () =>
    Effect.gen(function* () {
      const lines = yield* screen(["--version"])

      assert.match(lines[0] ?? "", drawn, "the version screen opens on the logo")
      assert.isTrue(
        lines.some((line) => line.includes(projectUrl)),
        `the version screen says ${projectUrl}`
      )
      assert.isTrue(
        lines.some((line) => line.includes("dw-mc") && line.includes(version)),
        "the version string itself is still printed"
      )
    })
  )

  it.effect("stays off the help screen of a subcommand", () =>
    Effect.gen(function* () {
      const lines = yield* screen(["status", "--help"])

      assert.strictEqual(lines[0], "DESCRIPTION")
      assert.isFalse(
        lines.some((line) => line.includes(projectUrl)),
        "a screen I read while working carries no header"
      )
    })
  )

  it.effect("stays off the help screen a failed parse prints, so the error is not buried", () =>
    Effect.gen(function* () {
      const lines = yield* screen(["bogus"])

      assert.strictEqual(lines[0], "DESCRIPTION")
      assert.isFalse(
        lines.some((line) => line.includes(projectUrl)),
        "the error screen carries no header"
      )
    })
  )

  it.effect("draws without escape sequences when nothing is watching a terminal", () =>
    Effect.gen(function* () {
      const lines = yield* screen(["--help"])

      assert.notInclude(lines.join("\n"), "\u001b[", "a piped help screen is plain text")
    })
  )

  it.effect("colours the header on a terminal", () =>
    Effect.gen(function* () {
      const lines = yield* screen(["--help"], { terminal: true })

      assert.include(above(lines).join("\n"), "\u001b[", "a terminal gets the colours")
    })
  )

  it.effect("drops the colours on a terminal when NO_COLOR is set", () =>
    Effect.gen(function* () {
      const lines = yield* screen(["--help"], { terminal: true, env: { NO_COLOR: "1" } })

      assert.notInclude(lines.join("\n"), "\u001b[", "NO_COLOR is honoured")
    })
  )
})
