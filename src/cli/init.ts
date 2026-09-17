import { Console, Effect, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import type { ConfigFile, Effort, SettingsPatch } from "#adapters/config.ts"
import { builtIn, ConfigStore, encode, merge, read, withDefaults, withRepo, write } from "#adapters/config.ts"
import { currentRepo, requireAuth } from "#adapters/gh.ts"
import { stateDirectory } from "#adapters/store.ts"
import { asUserError } from "#cli/sweep.ts"

const effortFlag = Flag.Literals("effort", ["low", "medium", "high", "xhigh", "max"]).pipe(
  Flag.withDescription("How much a review run spends on this repository"),
  Flag.optional
)

const baseFlag = Flag.String("base").pipe(
  Flag.withDescription("The branch this repository's pull requests target, over the default one"),
  Flag.optional
)

/** The settings the flags asked for, and only those. */
const asked = (base: Option.Option<string>, effort: Option.Option<Effort>): SettingsPatch => ({
  ...(Option.isSome(base) ? { base: base.value } : {}),
  ...(Option.isSome(effort) ? { review: { effort: effort.value } } : {})
})

/** What a review will open on, as the setup prints it back. */
const opening = (defaults: SettingsPatch): string => {
  const review = { ...builtIn.review, ...defaults.review }
  return review.command === null
    ? "my own prompt"
    : [review.command, review.effort].filter((part) => part !== null).join(" ")
}

const row = (label: string, value: string): string => `${label.padEnd(12)}${value}`

/**
 * Both the machine setup and the repository registration: there is deliberately
 * no separate `setup` command.
 *
 * The first run on a machine checks `gh` and spells the defaults out in the
 * configuration file. Run inside a repository, it also registers that
 * `owner/repo`, taking the name from `gh` so I never type it. Run again, it
 * changes what the flags name, keeps every other setting the file already had,
 * and leaves the file untouched where nothing was decided differently.
 *
 * It asks nothing. Reviews run on Claude Code, and what a run opens on is
 * `review.command` and `review.prompt` - a line and a paragraph that belong in
 * the file rather than in a terminal prompt.
 *
 * `--effort` and `--base` are about one repository, so they land on the
 * repository this ran in, or in the defaults when it ran outside one.
 */
export const init = Command.make(
  "init",
  { effort: effortFlag, base: baseFlag },
  Effect.fn("init")(
    function* ({ base, effort }) {
      yield* requireAuth

      const config = yield* ConfigStore
      const before = yield* read
      const file: ConfigFile = Option.getOrElse(before, (): ConfigFile => ({}))

      // A defaults block is what says this machine has been set up. On a first
      // run the built-in defaults go under whatever the file already said, so
      // spelling them out cannot overwrite a setting I chose by hand.
      const firstRun = file.defaults === undefined
      const defaults = firstRun ? merge(builtIn, file.defaults ?? {}) : (file.defaults ?? {})

      const state = yield* stateDirectory
      const repo = yield* currentRepo.pipe(
        Effect.asSome,
        Effect.catchTag("NoRepository", () => Effect.succeedNone)
      )

      const overrides = asked(base, effort)
      const written = Option.isSome(repo)
        ? withRepo(withDefaults(file, defaults), repo.value, overrides)
        : withDefaults(file, merge(defaults, overrides))

      if (encode(written) !== encode(file) || Option.isNone(before)) {
        yield* write(written)
      }

      yield* Console.log(row("review", opening(written.defaults ?? {})))
      yield* Console.log(row("config", config.path))
      yield* Console.log(row("state", state))
      yield* Console.log(
        Option.isNone(repo)
          ? row("repository", "none here - run dw-mc init inside a repository to register it")
          : row(
              "repository",
              `${repo.value} (${file.repos?.[repo.value] === undefined ? "registered" : "already registered"})`
            )
      )
    },
    // The failures worth a sentence become one, so a machine or a file that
    // needs fixing says what to fix instead of printing a stack.
    Effect.catchTag(["ConfigMalformed", "GhUnauthenticated", "GhUnavailable", "GhUnreadable"], asUserError)
  )
).pipe(Command.withDescription("Set this machine up and register the repository I am in"))
