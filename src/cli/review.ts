import { Console, DateTime, Effect, Exit, Option, Result, Schema } from "effect"
import { CliError, Command, Flag } from "effect/unstable/cli"

import type { ConfigFile, Effort, Launcher, Runner, Settings } from "#adapters/config.ts"
import { launcherOf, read as readConfig, settingsFor } from "#adapters/config.ts"
import { comparedFiles, prView } from "#adapters/gh.ts"
import { withWorktree } from "#adapters/git.ts"
import { announce } from "#adapters/notify.ts"
import type { Doing } from "#adapters/progress.ts"
import { spinning } from "#adapters/progress.ts"
import type { RunnerFailed } from "#adapters/runner.ts"
import { builtinFindings, builtinReview, promptRun } from "#adapters/runner.ts"
import { stateDirectory, storeFor, textStoreFor } from "#adapters/store.ts"
import { lines, summary } from "#cli/findings.ts"
import { named, prArgument } from "#cli/pr.ts"
import { asUserError, userFacing } from "#cli/sweep.ts"
import { count } from "#cli/table.ts"
import { asMarkdown, jsonSchema, Reported } from "#domain/findings.ts"
import type { Reviewing } from "#domain/persona.ts"
import { reviewPrompt } from "#domain/persona.ts"
import type { Asked, Outcome } from "#domain/review.ts"
import {
  decidingIn,
  LastReviewed,
  lastRun,
  latestKey,
  reportDocument,
  reportedBy,
  reportKey,
  ReviewRun,
  runKey,
  runnersFor,
  short,
  skippedSince
} from "#domain/review.ts"

/** What the spinner says a run has got through, while it is still going. */
const reviewing =
  (runner: Runner) =>
  (doing: Doing, since: string): string =>
    [
      `${runner} reviewing`,
      count(doing.tools, "tool"),
      doing.subagents === 0 ? null : count(doing.subagents, "subagent"),
      since
    ]
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

/** The runners a review run executes, or the sentence saying there are none. */
const runnersOf = (configured: ReadonlyArray<Runner>) => {
  const runners = runnersFor(configured)
  return runners.length === 0
    ? Effect.fail(
        new CliError.UserError({
          cause:
            "This repository reviews on no runner at all. " +
            "Set review.runners to one or more of builtin, prompt and codex."
        })
      )
    : Effect.succeed(runners)
}

/**
 * What the re-run rule is asked about, read before anything is cut or spawned:
 * the whole point of the rule is not paying for the run.
 *
 * It is asked per runner, because a second opinion that has never seen this
 * pull request is not skipped for the head the primary review already read.
 *
 * GitHub is asked what changed only where there is a run to measure from and a
 * different head to measure to. Neither is the rule deciding anything - there is
 * simply nothing to compare - and a comparison GitHub would not answer comes
 * back as nothing known rather than as a failure of the command.
 */
const askedOf = Effect.fn("review.askedOf")(function* (repo: string, number: number, head: string, runner: Runner) {
  const last = Option.getOrNull(yield* lastRun(repo, number, runner))
  const changed =
    last === null || last.head === head
      ? null
      : Option.getOrNull(yield* Effect.option(comparedFiles(repo, last.head, head)))
  return { last, head, changed } satisfies Asked
})

/**
 * How a run reads on the line above it: which runner, and what it was told to
 * spend.
 *
 * `review.effort` drives the built-in review command and nothing else, and
 * `review.model` drives the prompt the tool owns, so each run says the one that
 * decided anything about it.
 */
const spending = (runner: Runner, effort: Effort, model: string | null): string =>
  runner === "builtin" ? `${runner}, effort ${effort}` : model === null ? runner : `${runner}, model ${model}`

/** What one runner came back with, as far as the runner itself gets. */
interface Reviewed {
  /** The session the run happened in. */
  readonly sessionId: string
  /** What the runner said in prose, or null where a schema left it none to say. */
  readonly prose: string | null
  /**
   * The findings as they weighed, or whatever stopped them weighing: a turn
   * that could not report, and a turn that answered in a shape that does not
   * validate, are the same kind of failure of the same run.
   */
  readonly reported: Result.Result<typeof Reported.Type, { readonly message: string }>
}

/** What is written down about one runner's review. */
interface Ran {
  readonly sessionId: string | null
  /** The prose the report document is written from. */
  readonly prose: string
  readonly outcome: Outcome
}

/**
 * One runner's review of the head in the worktree.
 *
 * `builtin` is two turns of one session: the agent's own review as prose, then
 * the same review reported as findings. `prompt` and `codex` are one turn on
 * the tool's own prompt, which carries the schema with it, so the findings are
 * what the run answers with.
 *
 * Whatever the reporting comes to is a value and not a failure: the review is
 * already worth keeping, and a turn that could not report is recorded as the
 * failure it is rather than lost with it.
 */
const reviewOn = Effect.fn("review.reviewOn")(function* (options: {
  readonly runner: Runner
  readonly launcher: Launcher
  readonly directory: string
  readonly effort: Effort
  readonly settings: Settings
  /** What the run is about, which is what the tool's own prompt is written from. */
  readonly about: Reviewing
}) {
  const said = reviewing(options.runner)
  const { directory, launcher, settings } = options

  if (options.runner === "builtin") {
    const turn = yield* spinning(said, (onTool) =>
      builtinReview({ launcher, directory, effort: options.effort, onTool })
    )
    const reported = yield* Effect.result(
      Effect.flatMap(builtinFindings({ launcher, directory, sessionId: turn.sessionId, jsonSchema }), (output) =>
        Schema.decodeUnknownEffect(Reported)(output)
      )
    )
    return { sessionId: turn.sessionId, prose: turn.report, reported } satisfies Reviewed
  }

  const prompt = reviewPrompt(options.about)
  const run = yield* spinning(said, (onTool) =>
    promptRun({
      runner: options.runner,
      launcher,
      directory,
      prompt,
      model: settings.review.model,
      jsonSchema,
      onTool
    })
  )
  const reported = yield* Effect.result(Schema.decodeUnknownEffect(Reported)(run.findings))
  return { sessionId: run.sessionId, prose: run.prose, reported } satisfies Reviewed
})

/**
 * What a runner's review comes to on disk: the findings it reported, or the
 * failure it reached instead.
 *
 * A runner that would not start is as much a failure as a turn that answered in
 * a shape that does not validate, and both are recorded: the head has been
 * tried and nothing was found, which is not the same as nothing being wrong.
 */
const ranBy = (got: Result.Result<Reviewed, RunnerFailed>): Ran => {
  if (Result.isFailure(got)) {
    return { sessionId: null, prose: "", outcome: { _tag: "failed", detail: got.failure.detail } }
  }
  const { prose, reported, sessionId } = got.success
  if (Result.isFailure(reported)) {
    return { sessionId, prose: prose ?? "", outcome: { _tag: "failed", detail: reported.failure.message } }
  }
  const found = reported.success
  return {
    sessionId,
    // A runner held to a schema answers in findings and not in prose, so the
    // report kept beside it is written from what it found.
    prose: prose ?? asMarkdown(found),
    outcome: { _tag: "reported", verdict: found.verdict, findings: found.findings }
  }
}

/** One runner's review, once it has been written down. */
interface Recorded {
  readonly run: ReviewRun
  readonly prose: string
}

/**
 * The command's own failure where a runner that decides my bar reported
 * nothing, and nothing where they all reported.
 *
 * Every run is written down either way; what the exit code says is whether the
 * review I asked for is one to trust. A second opinion that could not report is
 * said out loud and no more: it informs me, so its silence is not my command
 * failing.
 */
const unreported = (recorded: ReadonlyArray<Recorded>, deciding: ReadonlyArray<Runner>, number: number) => {
  const failed = recorded.filter((it) => deciding.includes(it.run.runner) && it.run.outcome._tag === "failed")
  return failed.length === 0
    ? Effect.void
    : Effect.fail(
        new CliError.UserError({
          cause:
            `The review ran and its findings did not: ` +
            `${failed.map((it) => `${it.run.runner}: ${it.run.outcome._tag === "failed" ? it.run.outcome.detail : ""}`).join("; ")}. ` +
            `Run dw-mc review ${number} --force to run it again.`
        })
      )
}

/**
 * One review run, started by hand, in the foreground.
 *
 * A model runs here and nowhere else in the tool: there is no watch mode and
 * nothing reviews in the background, because a review costs real money and I am
 * the one who decides to spend it.
 *
 * The run happens in a throwaway worktree of the tool's own clone, so what is
 * reviewed is the pull request's head rather than whatever I have open. Every
 * configured runner reviews in that one worktree, one after the other: the
 * cutting is the expensive part that they can share, and a second opinion is
 * worth nothing if it read different code.
 *
 * What they found is kept against that head, one record per runner, which is
 * what takes the pull request out of Needs review run and what a blocking
 * finding later puts into Needs me.
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
      const configured = yield* runnersOf(settings.review.runners)
      const deciding = decidingIn(configured, settings.stamp.supporting_blocks)
      const spend = Option.getOrElse(effort, () => settings.review.effort)

      const view = yield* prView(repo, number)
      yield* Console.log(`${repo}#${number}  ${view.title}`)

      const asked = yield* Effect.forEach(configured, (runner) =>
        Effect.map(
          force
            ? Effect.succeed(null)
            : Effect.map(askedOf(repo, number, view.headRefOid, runner), (it) =>
                skippedSince(it, settings.review.docs_only)
              ),
          (since) => ({ runner, since })
        )
      )
      for (const { runner, since } of asked) {
        if (since !== null) {
          yield* Console.log(
            `  ${runner}: only documentation changed since ${short(since)}, so this run is skipped. ` +
              `Pass --force to review it anyway.`
          )
        }
      }
      const running = asked.filter((it) => it.since === null).map((it) => it.runner)
      if (running.length === 0) {
        return
      }

      const about: Reviewing = {
        repo,
        number,
        title: view.title,
        base: view.baseRefName,
        skill: settings.review.skill
      }

      // The bell and the notification are what let me walk away from a run that
      // takes minutes, so they ring however it ended: a run that gave up while I
      // was elsewhere is the one I most need to hear about.
      yield* Effect.gen(function* () {
        const ran = yield* withWorktree(repo, number, (worktree) =>
          Effect.gen(function* () {
            const done: Array<{ readonly runner: Runner; readonly ran: Ran }> = []
            for (const runner of running) {
              yield* Console.log(`  head ${short(worktree.head)}  ${spending(runner, spend, settings.review.model)}`)
              const got = yield* Effect.result(
                reviewOn({ runner, launcher, directory: worktree.directory, effort: spend, settings, about })
              )
              done.push({ runner, ran: ranBy(got) })
            }
            return { head: worktree.head, done }
          })
        )

        const ranAt = yield* DateTime.now
        const runs = yield* storeFor("runs", ReviewRun)
        const latest = yield* storeFor("runs", LastReviewed)
        const reports = yield* textStoreFor("runs")

        const recorded: Array<Recorded> = []
        for (const { ran: got, runner } of ran.done) {
          const run: ReviewRun = {
            repo,
            number,
            head: ran.head,
            runner,
            effort: spend,
            sessionId: got.sessionId,
            ranAt,
            outcome: got.outcome
          }
          yield* runs.set(runKey(repo, number, run.head, runner), run)
          yield* latest.set(latestKey(repo, number, runner), { head: run.head })
          yield* reports.set(reportKey(repo, number, run.head, runner), reportDocument(run, view.title, got.prose))
          recorded.push({ run, prose: got.prose })
        }

        for (const { prose, run } of recorded) {
          yield* Console.log("")
          // One runner says which it was on the line above its run already; more
          // than one and the reports need telling apart.
          if (recorded.length > 1) {
            yield* Console.log(`${run.runner}:`)
          }
          const found = reportedBy(run)
          if (found === null) {
            yield* Console.log(`  reported nothing: ${run.outcome._tag === "failed" ? run.outcome.detail : ""}`)
            continue
          }
          if (prose !== "") {
            yield* Console.log(prose)
            yield* Console.log("")
          }
          yield* Console.log(summary(found, settings.stamp.blocks_on))
          for (const line of lines(found)) {
            yield* Console.log(`  ${line}`)
          }
        }

        yield* Console.log(`Recorded against ${short(ran.head)} in ${yield* stateDirectory}`)
        yield* unreported(recorded, deciding, number)
      }).pipe(
        Effect.onExit((exit) =>
          announce("dw-mc review", `${repo}#${number} ${Exit.isSuccess(exit) ? "reviewed" : "could not be reviewed"}`)
        )
      )
    },
    // No `RunnerFailed` here: every runner's own failure is caught where it
    // happens and written down as the run's outcome, so none of them reaches
    // this far.
    Effect.catchTag([...userFacing, "GitFailed"], asUserError)
  )
).pipe(Command.withDescription("Review one pull request on the configured runners, in a throwaway worktree"))
