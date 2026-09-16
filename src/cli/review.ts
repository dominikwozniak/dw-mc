import { Console, DateTime, Effect, Option } from "effect"
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"

import type { ConfigFile, Settings } from "#adapters/config.ts"
import { read as readConfig, settingsFor } from "#adapters/config.ts"
import { prView } from "#adapters/gh.ts"
import { withWorktree } from "#adapters/git.ts"
import { announce } from "#adapters/notify.ts"
import { builtinReview } from "#adapters/runner.ts"
import { stateDirectory, storeFor, textStoreFor } from "#adapters/store.ts"
import { asUserError, userFacing } from "#cli/sweep.ts"
import type { Reference } from "#domain/reference.ts"
import { resolve } from "#domain/reference.ts"
import { reportDocument, reportKey, ReviewRun, runKey } from "#domain/review.ts"

const prArgument = Argument.String("pr").pipe(
  Argument.withDescription("The pull request to review, as 28 or owner/name#28")
)

const effortFlag = Flag.Literals("effort", ["low", "medium", "high"]).pipe(
  Flag.withDescription("How much this run spends, over what the repository configured"),
  Flag.optional
)

/** What to say about a reference that named no one pull request. */
const cannotTell = (reference: Exclude<Reference, { readonly _tag: "resolved" }>): string => {
  if (reference._tag === "unreadable") {
    return `'${reference.text}' is not a pull request. Name one as 28, or as owner/name#28.`
  }
  const example = `${reference.repos[0] ?? "owner/name"}#28`
  return reference.repos.length === 0
    ? `No repositories are registered, so a number alone names nothing. ` +
        `Run dw-mc init inside a repository, or name the pull request as ${example}.`
    : `${reference.repos.length} repositories are registered, so a number alone could be any of them. ` +
        `Name the pull request as ${example}.`
}

/** The pull request the argument names, or the sentence saying why it names none. */
const named = (pr: string, registered: ReadonlyArray<string>) => {
  const reference = resolve(pr, registered)
  return reference._tag === "resolved"
    ? Effect.succeed(reference)
    : Effect.fail(new CliError.UserError({ cause: cannotTell(reference) }))
}

/**
 * The runner to execute on, while `builtin` is the only one there is.
 *
 * A repository that asks for a runner this version cannot run is told so
 * rather than quietly reviewed on the other one: which runner read the code is
 * half of what a review run means.
 */
const runnerFor = (settings: Settings) =>
  settings.review.runners.includes("builtin")
    ? Effect.succeed("builtin" as const)
    : Effect.fail(
        new CliError.UserError({
          cause:
            `This repository reviews on ${settings.review.runners.join(", ")}, and only the builtin runner ` +
            `exists so far. Set review.runners to [builtin] for it.`
        })
      )

/**
 * One review run, started by hand, in the foreground.
 *
 * A model runs here and nowhere else in the tool: there is no watch mode and
 * nothing reviews in the background, because a review costs real money and I am
 * the one who decides to spend it.
 *
 * The run happens in a throwaway worktree of the tool's own clone, so what is
 * reviewed is the pull request's head rather than whatever I have open. What it
 * found is kept against that head, which is what takes the pull request out of
 * Needs review run and what the follow-up turn resumes from.
 *
 * The report is printed as well as kept. A run I waited minutes for should not
 * need a second command to read.
 */
export const review = Command.make(
  "review",
  { pr: prArgument, effort: effortFlag },
  Effect.fn("review")(
    function* ({ effort, pr }) {
      const file: ConfigFile = Option.getOrElse(yield* readConfig, (): ConfigFile => ({}))
      const { number, repo } = yield* named(pr, Object.keys(file.repos ?? {}).toSorted())
      const settings = settingsFor(file, repo)
      const runner = yield* runnerFor(settings)
      const spend = Option.getOrElse(effort, () => settings.review.effort)

      const view = yield* prView(repo, number)
      yield* Console.log(`${repo}#${number}  ${view.title}`)

      const done = yield* withWorktree(repo, number, (worktree) =>
        Effect.gen(function* () {
          yield* Console.log(`  head ${worktree.head.slice(0, 7)}  ${runner}, effort ${spend}`)
          const turn = yield* builtinReview({
            directory: worktree.directory,
            effort: spend,
            onTool: (tool) => Console.log(`  · ${tool}`)
          })
          return { head: worktree.head, turn }
        })
      )

      const run: ReviewRun = {
        repo,
        number,
        head: done.head,
        runner,
        effort: spend,
        sessionId: done.turn.sessionId,
        ranAt: yield* DateTime.now
      }

      const runs = yield* storeFor("runs", ReviewRun)
      const reports = yield* textStoreFor("runs")
      yield* runs.set(runKey(repo, number, run.head), run)
      yield* reports.set(reportKey(repo, number, run.head), reportDocument(run, view.title, done.turn.report))

      yield* Console.log("")
      yield* Console.log(done.turn.report)
      yield* Console.log("")
      yield* Console.log(`Recorded against ${run.head.slice(0, 7)} in ${yield* stateDirectory}`)
      yield* announce("dw-mc review", `${repo}#${number} reviewed`)
    },
    Effect.catchTag([...userFacing, "GitFailed", "RunnerFailed"], asUserError)
  )
).pipe(Command.withDescription("Review one pull request on the configured runner, in a throwaway worktree"))
