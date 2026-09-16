import { Console, Effect, Option } from "effect"
import { CliError, Command, Flag, Prompt } from "effect/unstable/cli"
import type { ConfigFile, Runner, SettingsPatch } from "./config.ts"
import { builtIn, ConfigStore, merge, read, write } from "./config.ts"
import { currentRepo, requireAuth } from "./gh.ts"
import { openStateDirectory } from "./store.ts"

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

/** The settings the flags asked for, and only those. */
const asked = (
  base: Option.Option<string>,
  effort: Option.Option<"low" | "medium" | "high">
): SettingsPatch => ({
  ...(Option.isSome(base) ? { base: base.value } : {}),
  ...(Option.isSome(effort) ? { review: { effort: effort.value } } : {})
})

const decidesNothing = (patch: SettingsPatch): boolean => Object.keys(patch).length === 0

const row = (label: string, value: string): string => `${label.padEnd(12)}${value}`

/**
 * Both the machine setup and the repository registration: there is deliberately
 * no separate `setup` command.
 *
 * The first run on a machine checks `gh`, settles the runner, and leaves the
 * state directory and the configuration file behind it. Run inside a
 * repository, it also registers that `owner/repo`, taking the name from `gh` so
 * I never type it. Run again, it changes what the flags name and keeps every
 * other setting the file already had.
 *
 * `--runner` is a choice about this machine, so it lands in the global
 * defaults. `--effort` and `--base` are about one repository, so they land on
 * the repository this ran in, or in the defaults when it ran outside one.
 */
export const init = Command.make(
  "init",
  { runner: runnerFlag, effort: effortFlag, base: baseFlag },
  Effect.fn("init")(
    function*({ base, effort, runner }) {
      yield* requireAuth

      const config = yield* ConfigStore
      const before = yield* read
      const file: ConfigFile = Option.getOrElse(before, (): ConfigFile => ({}))

      // The file itself is what says the machine has been set up.
      const firstRun = Option.isNone(before)
      const chosen: Option.Option<Runner> = Option.isSome(runner)
        ? Option.some(runner.value)
        : firstRun
        ? Option.some(yield* askRunner)
        : Option.none()
      const runnerPatch: SettingsPatch = Option.isSome(chosen)
        ? { review: { runners: [chosen.value] } }
        : {}
      const defaults = firstRun
        ? merge(builtIn, runnerPatch)
        : decidesNothing(runnerPatch)
        ? file.defaults
        : merge(file.defaults ?? {}, runnerPatch)

      const state = yield* openStateDirectory
      const repo = yield* currentRepo.pipe(
        Effect.asSome,
        Effect.catchTag("NoRepository", () => Effect.succeedNone)
      )

      const delta = asked(base, effort)
      const settled = Option.isSome(repo)
        ? {
          defaults,
          repos: { ...file.repos, [repo.value]: merge(file.repos?.[repo.value] ?? {}, delta) }
        }
        : {
          defaults: decidesNothing(delta) ? defaults : merge(defaults ?? {}, delta),
          repos: file.repos
        }
      const written: ConfigFile = {
        ...(settled.defaults === undefined ? {} : { defaults: settled.defaults }),
        ...(settled.repos === undefined ? {} : { repos: settled.repos })
      }

      yield* write(written)

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
    // The failures worth a sentence become one, so a machine that needs fixing
    // says what to fix instead of printing a stack.
    Effect.catchTags({
      GhUnavailable: (cause) => Effect.fail(new CliError.UserError({ cause })),
      GhUnauthenticated: (cause) => Effect.fail(new CliError.UserError({ cause })),
      GhUnreadable: (cause) => Effect.fail(new CliError.UserError({ cause })),
      ConfigMalformed: (cause) => Effect.fail(new CliError.UserError({ cause }))
    })
  )
).pipe(
  Command.withDescription("Set this machine up and register the repository I am in")
)
