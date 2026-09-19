import { Console, Effect, FileSystem, Path } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import { configDirectory, configPath } from "#adapters/config.ts"
import { holding } from "#adapters/git.ts"
import type { Paint } from "#adapters/paint.ts"
import { Paint as PaintService } from "#adapters/paint.ts"
import { confirm } from "#adapters/picker.ts"
import { discard, inventory } from "#adapters/store.ts"
import { block, print, separated } from "#cli/block.ts"
import { yesFlag } from "#cli/cleanup.ts"
import { table } from "#cli/table.ts"
import type { Standing } from "#domain/cleanup.ts"
import { everything, standing, weight } from "#domain/cleanup.ts"

const configFlag = Flag.Boolean("config").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Take the configuration file too, and not only the state")
)

const forceFlag = Flag.Boolean("force").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Remove a session worktree that still holds work of mine")
)

/** A worktree that still holds something, and what it holds. */
interface Held {
  readonly at: Standing
  readonly detail: string
}

const removes = (
  state: { readonly directory: string; readonly size: string },
  config: string | undefined,
  paint: Paint
): ReadonlyArray<string> =>
  block(
    "Removes",
    table([
      [paint.dim(state.directory), state.size, "every record, report, clone and worktree"],
      ...(config === undefined ? [] : [[paint.dim(config), "", "the runner and every repository registered"]])
    ])
  )

const held = (holds: ReadonlyArray<Held>, paint: Paint): ReadonlyArray<string> =>
  holds.length === 0
    ? []
    : block("Holds work of mine", table(holds.map((it) => [paint.dim(it.at.directory), it.detail])))

/**
 * Takes the tool's own footprint off this machine, which no package manager
 * does.
 *
 * Removing the package removes the binary and nothing else - verified by
 * running it: `pnpm remove` runs no `uninstall` script of any name, so a tool
 * that writes outside its own directory has to say goodbye itself. This is that
 * goodbye, and the one step it cannot take is printed rather than pretended.
 *
 * The state goes in full, because every byte of it is the tool's own record of
 * what it read. The configuration file is the one thing I decided rather than
 * the tool, and it is small, readable and possibly in my dotfiles, so it stays
 * unless `--config` asks for it.
 *
 * A worktree that a fix or resolve session left standing is asked what it still
 * holds before anything is removed, and one holding uncommitted changes or a
 * commit the pull request's head does not have stops the whole command. That is
 * the one thing here no reflog of mine brings back.
 */
export const uninstall = Command.make(
  "uninstall",
  { config: configFlag, force: forceFlag, yes: yesFlag },
  Effect.fn("uninstall")(function* ({ config: alsoConfig, force, yes }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const paint = yield* PaintService

    const found = yield* inventory
    const file = yield* configPath
    const configured = yield* fs.exists(file)

    const holds: ReadonlyArray<Held> = yield* Effect.forEach(standing(found), (at) =>
      Effect.map(holding(at.repo, at.number, at.session), (holding_) =>
        holding_._tag === "held" ? [{ at, detail: holding_.detail }] : []
      )
    ).pipe(Effect.map((found_) => found_.flat()))

    // The blank line closes the report, before the question or the outcome.
    yield* print([
      ...separated([
        removes(
          { directory: found.directory, size: weight(everything(found)) },
          alsoConfig && configured ? file : undefined,
          paint
        ),
        held(holds, paint)
      ]),
      ""
    ])

    if (holds.length > 0 && !force) {
      yield* Console.log("Nothing was removed. Push that work or drop it, or run this again with --force.")
      return
    }

    if (!yes && !(yield* confirm("Remove it all?"))) {
      yield* Console.log("Nothing was removed.")
      return
    }

    yield* discard(found.directory)
    if (alsoConfig) {
      yield* discard(yield* configDirectory)
    }

    yield* Console.log(`Removed ${found.directory}${alsoConfig ? ` and ${path.dirname(file)}` : ""}.`)
    if (!alsoConfig && configured) {
      yield* Console.log(`The configuration file stays at ${file}. Run this again with --config to take it too.`)
    }
    yield* Console.log("Run pnpm remove -g dw-mc to take the binary, which is all that is left.")
  })
).pipe(Command.withDescription("Take everything this tool wrote off the machine"))
