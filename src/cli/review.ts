import { Console, DateTime, Effect, Exit, Option, Result, Schema } from "effect"
import { CliError, Command, Flag } from "effect/unstable/cli"

import type { ConfigFile, Runner } from "#adapters/config.ts"
import { launcherOf, read as readConfig, settingsFor } from "#adapters/config.ts"
import { comparedFiles, prView } from "#adapters/gh.ts"
import { withWorktree } from "#adapters/git.ts"
import { announce } from "#adapters/notify.ts"
import type { Doing } from "#adapters/progress.ts"
import { spinning } from "#adapters/progress.ts"
import { builtinFindings, builtinReview } from "#adapters/runner.ts"
import { stateDirectory, storeFor, textStoreFor } from "#adapters/store.ts"
import { lines, summary } from "#cli/findings.ts"
import { named, prArgument } from "#cli/pr.ts"
import { asUserError, userFacing } from "#cli/sweep.ts"
import { count } from "#cli/table.ts"
import { jsonSchema, Reported } from "#domain/findings.ts"
import type { Asked, Outcome } from "#domain/review.ts"
import {
  LastReviewed,
  lastRun,
  latestKey,
  reportDocument,
  reportedBy,
  reportKey,
  ReviewRun,
  short,
  runKey,
  runnerFor,
  skippedSince
} from "#domain/review.ts"

/** What the spinner says a run has got through, while it is still going. */
const reviewing = (doing: Doing, since: string): string =>
  ["reviewing", count(doing.tools, "tool"), doing.subagents === 0 ? null : count(doing.subagents, "subagent"), since]
    .filter((part) => part !== null)
    .join(" · ")

const effortFlag = Flag.Literals("effort", ["low", "medium", "high"]).pipe(
  Flag.withDescription("How much this run spends, over what the repository configured"),
  Flag.optional
)

const forceFlag = Flag.Boolean("force").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Review even where the re-run rule would skip it")
)

/** The runner a review run executes on, or the sentence saying why there is none. */
const runnerOf = (runners: ReadonlyArray<Runner>) => {
  const runner = runnerFor(runners)
  return runner === null
    ? Effect.fail(
        new CliError.UserError({
          cause:
            `This repository reviews on ${runners.join(", ")}, and only the builtin runner exists so far. ` +
            `Set review.runners to [builtin] for it.`
        })
      )
    : Effect.succeed(runner)
}

/**
 * What the re-run rule is asked about, read before anything is cut or spawned:
 * the whole point of the rule is not paying for the run.
 *
 * GitHub is asked what changed only where there is a run to measure from and a
 * different head to measure to. Neither is the rule deciding anything - there is
 * simply nothing to compare - and a comparison GitHub would not answer comes
 * back as nothing known rather than as a failure of the command.
 */
const askedOf = Effect.fn("review.askedOf")(function* (repo: string, number: number, head: string) {
  const last = Option.getOrNull(yield* lastRun(repo, number))
  const changed =
    last === null || last.head === head
      ? null
      : Option.getOrNull(yield* Effect.option(comparedFiles(repo, last.head, head)))
  return { last, head, changed } satisfies Asked
})

/**
 * The command's own failure where the second turn did not report, and nothing
 * where it did.
 *
 * The run is written down either way; what the exit code says is whether it is
 * one to trust.
 */
const unreported = (outcome: Outcome) =>
  outcome._tag === "failed"
    ? Effect.fail(new CliError.UserError({ cause: `The review ran and its findings did not: ${outcome.detail}` }))
    : Effect.void

/**
 * One review run, started by hand, in the foreground.
 *
 * A model runs here and nowhere else in the tool: there is no watch mode and
 * nothing reviews in the background, because a review costs real money and I am
 * the one who decides to spend it.
 *
 * The run happens in a throwaway worktree of the tool's own clone, so what is
 * reviewed is the pull request's head rather than whatever I have open. It is
 * two turns of one session: the first writes the review as prose, the second
 * reports the same review as findings that validate. What they found is kept
 * against that head, which is what takes the pull request out of Needs review
 * run and what a blocking finding later puts into Needs me.
 *
 * The report is printed as well as kept. A run I waited minutes for should not
 * need a second command to read.
 */
export const review = Command.make(
  "review",
  { pr: prArgument, effort: effortFlag, force: forceFlag },
  Effect.fn("review")(
    function* ({ effort, force, pr }) {
      const file: ConfigFile = Option.getOrElse(yield* readConfig, (): ConfigFile => ({}))
      const { number, repo } = yield* named(pr, Object.keys(file.repos ?? {}).toSorted())
      const settings = settingsFor(file, repo)
      const launcher = launcherOf(file)
      const runner = yield* runnerOf(settings.review.runners)
      const spend = Option.getOrElse(effort, () => settings.review.effort)

      const view = yield* prView(repo, number)
      yield* Console.log(`${repo}#${number}  ${view.title}`)

      const since = force
        ? null
        : skippedSince(yield* askedOf(repo, number, view.headRefOid), settings.review.docs_only)
      if (since !== null) {
        yield* Console.log(
          `  Only documentation changed since ${short(since)}, so this run is skipped. ` +
            `Pass --force to review it anyway.`
        )
        return
      }

      // The bell and the notification are what let me walk away from a run that
      // takes minutes, so they ring however it ended: a run that gave up while I
      // was elsewhere is the one I most need to hear about.
      yield* Effect.gen(function* () {
        const ran = yield* withWorktree(repo, number, (worktree) =>
          Effect.gen(function* () {
            yield* Console.log(`  head ${short(worktree.head)}  ${runner}, effort ${spend}`)
            const turn = yield* spinning(reviewing, (onTool) =>
              builtinReview({ launcher, directory: worktree.directory, effort: spend, onTool })
            )
            // Whatever the second turn comes to is a value and not a failure:
            // the prose is already worth keeping, and a turn that could not
            // report is recorded as the failure it is rather than lost with it.
            const reported = yield* Effect.result(
              Effect.flatMap(
                builtinFindings({ launcher, directory: worktree.directory, sessionId: turn.sessionId, jsonSchema }),
                (output) => Schema.decodeUnknownEffect(Reported)(output)
              )
            )
            return { head: worktree.head, turn, reported }
          })
        )

        const outcome: Outcome = Result.isSuccess(ran.reported)
          ? { _tag: "reported", verdict: ran.reported.success.verdict, findings: ran.reported.success.findings }
          : { _tag: "failed", detail: ran.reported.failure.message }

        const run: ReviewRun = {
          repo,
          number,
          head: ran.head,
          runner,
          effort: spend,
          sessionId: ran.turn.sessionId,
          ranAt: yield* DateTime.now,
          outcome
        }

        const runs = yield* storeFor("runs", ReviewRun)
        const latest = yield* storeFor("runs", LastReviewed)
        const reports = yield* textStoreFor("runs")
        yield* runs.set(runKey(repo, number, run.head), run)
        yield* latest.set(latestKey(repo, number), { head: run.head })
        yield* reports.set(reportKey(repo, number, run.head), reportDocument(run, view.title, ran.turn.report))

        yield* Console.log("")
        yield* Console.log(ran.turn.report)
        yield* Console.log("")
        const found = reportedBy(run)
        if (found !== null) {
          yield* Console.log(summary(found, settings.stamp.blocks_on))
          for (const line of lines(found)) {
            yield* Console.log(`  ${line}`)
          }
        }
        yield* Console.log(`Recorded against ${short(run.head)} in ${yield* stateDirectory}`)

        yield* unreported(outcome)
      }).pipe(
        Effect.onExit((exit) =>
          announce("dw-mc review", `${repo}#${number} ${Exit.isSuccess(exit) ? "reviewed" : "could not be reviewed"}`)
        )
      )
    },
    Effect.catchTag([...userFacing, "GitFailed", "RunnerFailed"], asUserError)
  )
).pipe(Command.withDescription("Review one pull request on the configured runner, in a throwaway worktree"))
