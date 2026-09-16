import { Console, Effect, Option } from "effect"
import { CliError, Command, Flag, Prompt } from "effect/unstable/cli"

import type { ConfigFile, Runner, SettingsPatch } from "#adapters/config.ts"
import { builtIn, ConfigStore, encode, merge, read, withDefaults, withRepo, write } from "#adapters/config.ts"
import { currentRepo, requireAuth } from "#adapters/gh.ts"
import { stateDirectory } from "#adapters/store.ts"

const runnerFlag = Flag.Literals("runner", ["builtin", "prompt"]).pipe(
  Flag.withDescription("Which runner review runs execute on, on this machine"),
  Flag.optional
)

const effortFlag = Flag.Literals("effort", ["low", "medium", "high"]).pipe(
  Flag.withDescription("How much a built-in review run spends on this repository"),
  Flag.optional
)

const baseFlag = Flag.String("base").pipe(
  Flag.withDescription("The branch this repository's pull requests target, over the default one"),
  Flag.optional
)

const askRunner: Prompt.Prompt<Runner> = Prompt.Select({
  message: "Which runner should review runs execute on?",
  choices: [
    { title: "builtin", value: "builtin", description: "Claude Code's own code review" },
    {
      title: "prompt",
      value: "prompt",
      description: "The tool's own review prompt, on Claude Code or Codex"
    }
  ]
})

const noRunnerChosen =
  "No runner chosen, so nothing was written. " +
  "Pass --runner builtin or --runner prompt to choose without the prompt."

/** The settings the flags asked for, and only those. */
const asked = (base: Option.Option<string>, effort: Option.Option<"low" | "medium" | "high">): SettingsPatch => ({
  ...(Option.isSome(base) ? { base: base.value } : {}),
  ...(Option.isSome(effort) ? { review: { effort: effort.value } } : {})
})

const row = (label: string, value: string): string => `${label.padEnd(12)}${value}`

/**
 * Both the machine setup and the repository registration: there is deliberately
 * no separate `setup` command.
 *
 * The first run on a machine checks `gh`, settles the runner and spells the
 * defaults out in the configuration file. Run inside a repository, it also
 * registers that `owner/repo`, taking the name from `gh` so I never type it.
 * Run again, it changes what the flags name, keeps every other setting the file
 * already had, and leaves the file untouched where nothing was decided
 * differently.
 *
 * `--runner` is a choice about this machine, so it lands in the global
 * defaults. `--effort` and `--base` are about one repository, so they land on
 * the repository this ran in, or in the defaults when it ran outside one.
 */
export const init = Command.make(
  "init",
  { runner: runnerFlag, effort: effortFlag, base: baseFlag },
  Effect.fn("init")(
    function* ({ base, effort, runner }) {
      yield* requireAuth

      const config = yield* ConfigStore
      const before = yield* read
      const file: ConfigFile = Option.getOrElse(before, (): ConfigFile => ({}))

      // A settled runner is what says this machine has been set up.
      const firstRun = file.defaults?.review?.runners === undefined
      const chosen: Option.Option<Runner> = Option.isSome(runner)
        ? Option.some(runner.value)
        : firstRun
          ? Option.some(yield* askRunner)
          : Option.none()

      // On a first run the built-in defaults go under whatever the file already
      // said, so spelling them out cannot overwrite a setting I chose by hand.
      const inherited = firstRun ? merge(builtIn, file.defaults ?? {}) : (file.defaults ?? {})
      const defaults = merge(inherited, Option.isSome(chosen) ? { review: { runners: [chosen.value] } } : {})

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

      const runners = written.defaults?.review?.runners ?? builtIn.review.runners
      yield* Console.log(row("runner", runners.join(", ")))
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
    Effect.catchTag(["ConfigMalformed", "GhUnauthenticated", "GhUnavailable", "GhUnreadable", "QuitError"], (cause) =>
      Effect.fail(
        cause._tag === "QuitError"
          ? new CliError.UserError({ cause, userMessage: noRunnerChosen })
          : new CliError.UserError({ cause })
      )
    )
  )
).pipe(Command.withDescription("Set this machine up and register the repository I am in"))
