import { Console, Effect, Option } from "effect"
import { CliError, Command, Flag, Prompt } from "effect/unstable/cli"

import type { ConfigFile, Runner, SettingsPatch } from "#adapters/config.ts"
import { builtIn, ConfigStore, encode, merge, read, runners, withDefaults, withRepo, write } from "#adapters/config.ts"
import { currentRepo, requireAuth } from "#adapters/gh.ts"
import { stateDirectory } from "#adapters/store.ts"

const runnerFlag = Flag.Literals("runner", [...runners]).pipe(
  Flag.withDescription("Which runner is my bar, on this machine"),
  Flag.optional
)

const codexFlag = Flag.Boolean("codex").pipe(
  Flag.withDescription("Ask Codex for a second opinion beside the runner that is my bar"),
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
  message: "Which runner is your bar?",
  choices: [
    { title: "builtin", value: "builtin", description: "Claude Code's own code review" },
    { title: "prompt", value: "prompt", description: "The tool's own review prompt, on Claude Code" },
    { title: "codex", value: "codex", description: "The tool's own review prompt, on the Codex CLI" }
  ]
})

/**
 * The second question, and only where the first did not already answer it.
 *
 * Codex is the second opinion, so it is not one more thing in the list of what
 * my bar could be: it is a runner that runs beside it. A machine whose bar is
 * Codex has nothing left to ask.
 */
const askSecondOpinion: Prompt.Prompt<boolean> = Prompt.Confirm({
  message: "Also ask Codex for a second opinion on every review run?",
  initial: false
})

/**
 * What the file should name: the runner that is my bar, and Codex beside it
 * where I asked for one.
 *
 * Codex alone is the review rather than a second opinion, which is the rule
 * `#domain/review.ts` draws too, so it is never listed twice.
 */
const listing = (bar: Runner, secondOpinion: boolean): ReadonlyArray<Runner> =>
  bar === "codex" || !secondOpinion ? [bar] : [bar, "codex"]

const noRunnerChosen =
  "No runner chosen, so nothing was written. " +
  "Pass --runner builtin, --runner prompt or --runner codex to choose without the prompt, " +
  "and --codex for a second opinion beside it."

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
  { runner: runnerFlag, codex: codexFlag, effort: effortFlag, base: baseFlag },
  Effect.fn("init")(
    function* ({ base, codex, effort, runner }) {
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

      const listed = file.defaults?.review?.runners ?? builtIn.review.runners
      const bar = Option.getOrElse(chosen, () => listed.find((it) => it !== "codex") ?? "builtin")
      // Only where the runner was asked for too: `--runner` is what sets a
      // machine up without a terminal, and a prompt after it would take that
      // back.
      const asksCodex = firstRun && bar !== "codex" && Option.isNone(runner) && Option.isNone(codex)
      const secondOpinion: Option.Option<boolean> = asksCodex ? Option.some(yield* askSecondOpinion) : codex

      // The two questions are one setting, and each is remembered on its own: a
      // later run that names only one of them keeps the answer to the other.
      const decided = Option.isSome(chosen) || Option.isSome(secondOpinion)
      const beside = Option.getOrElse(secondOpinion, () => listed.includes("codex"))

      // On a first run the built-in defaults go under whatever the file already
      // said, so spelling them out cannot overwrite a setting I chose by hand.
      const inherited = firstRun ? merge(builtIn, file.defaults ?? {}) : (file.defaults ?? {})
      const defaults = merge(inherited, decided ? { review: { runners: listing(bar, beside) } } : {})

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

      const settled = written.defaults?.review?.runners ?? builtIn.review.runners
      yield* Console.log(row("runner", settled.join(", ")))
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
