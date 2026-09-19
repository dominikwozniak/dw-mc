import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Path, Stdio } from "effect"

import { ConfigStore } from "#adapters/config.ts"
import { coloured } from "#adapters/paint.ts"
import { layerScripted, recording } from "#adapters/picker.ts"
import { layerStubbed } from "#adapters/spawner.ts"
import * as Store from "#adapters/store.ts"
import { projectUrl, run, version } from "#cli/cli.ts"
import * as Header from "#cli/header.ts"

/**
 * The machine a help screen is printed on: a terminal or a pipe, with or
 * without `NO_COLOR`, and set up or not.
 */
interface Machine {
  readonly terminal?: boolean | undefined
  readonly env?: Record<string, string> | undefined
  /** What `config.yaml` says, where this machine has one. */
  readonly config?: string | undefined
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
  yield* Effect.gen(function* () {
    if (machine.config !== undefined) {
      const config = yield* ConfigStore
      yield* config.store.set("config.yaml", machine.config)
    }
    yield* run(...argv).pipe(Effect.ignoreCause, recording(printed))
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(Layer.provideMerge(Header.layer, ConfigStore.layerTest), Store.layerTest),
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

describe("what the root help screen says about this machine", () => {
  const three = "repos:\n  a/one: {}\n  a/two: {}\n  a/three: {}\n"

  /** The header's lines that name this machine's setup, by their label. */
  const naming = /^(config|state) /
  const setup = (lines: ReadonlyArray<string>) => above(lines).filter((line) => naming.test(line))

  it.effect("names the configuration, what it registers, and the state directory under the logo", () =>
    Effect.gen(function* () {
      const lines = yield* screen(["--help"], { config: three })

      assert.deepStrictEqual(setup(lines), [
        "config  ~/.config/dw-mc/config.yaml   3 repositories registered",
        "state   ~/.local/state/dw-mc"
      ])
    })
  )

  it.effect("names the directories XDG points at", () =>
    Effect.gen(function* () {
      const lines = yield* screen(["--help"], {
        config: "repos:\n  a/one: {}\n",
        env: { XDG_CONFIG_HOME: "/etc/xdg", XDG_STATE_HOME: "/var/state" }
      })

      assert.deepStrictEqual(setup(lines), [
        "config  /etc/xdg/dw-mc/config.yaml   1 repository registered",
        "state   /var/state/dw-mc"
      ])
    })
  )

  it.effect("dims the paths on a terminal and colours nothing by state", () =>
    Effect.gen(function* () {
      const lines = yield* screen(["--help"], { config: three, terminal: true })
      const config = lines.find((line) => line.startsWith("config")) ?? ""

      assert.include(config, coloured.dim("~/.config/dw-mc/config.yaml"))
      assert.include(config, "   3 repositories registered")
      assert.notInclude(config.replace(coloured.dim("~/.config/dw-mc/config.yaml"), ""), "\u001b[")
    })
  )

  it.effect("says a machine with no configuration is not set up, and how to set it up", () =>
    Effect.gen(function* () {
      const lines = yield* screen(["--help"])

      assert.deepStrictEqual(setup(lines), [
        "config  ~/.config/dw-mc/config.yaml   not set up - run dw-mc init",
        "state   ~/.local/state/dw-mc"
      ])
      assert.include(lines, "SUBCOMMANDS")
    })
  )

  it.effect("keeps the help screen when the configuration cannot be read, and says so", () =>
    Effect.gen(function* () {
      const lines = yield* screen(["--help"], { config: "repos:\n  a/one:\n    review:\n      skill: gone\n" })

      assert.deepStrictEqual(setup(lines), [
        "config  ~/.config/dw-mc/config.yaml   cannot be read - any other command says why",
        "state   ~/.local/state/dw-mc"
      ])
      assert.include(lines, "SUBCOMMANDS")
    })
  )

  it.effect("stays off --version, a subcommand's help and a failed parse", () =>
    Effect.gen(function* () {
      for (const argv of [["--version"], ["status", "--help"], ["bogus"]]) {
        const lines = yield* screen(argv, { config: three })

        assert.isFalse(
          lines.some((line) => naming.test(line)),
          `dw-mc ${argv.join(" ")} names nothing of this machine`
        )
      }
    })
  )
})
