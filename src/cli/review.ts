import { DateTime, Effect, Exit, Option, Result, Schema } from "effect"
import { CliError, Command, Flag } from "effect/unstable/cli"

import type { AgentFailed } from "#adapters/agent.ts"
import { reviewTurns } from "#adapters/claude.ts"
import type { Launcher, Settings } from "#adapters/config.ts"
import { comparedFiles, prView } from "#adapters/gh.ts"
import { withWorktree } from "#adapters/git.ts"
import type { Reads } from "#adapters/heartbeat.ts"
import { beating } from "#adapters/heartbeat.ts"
import { announce } from "#adapters/notify.ts"
import { Paint } from "#adapters/paint.ts"
import { stateDirectory, storeFor, textStoreFor } from "#adapters/store.ts"
import { block, following, indent, print } from "#cli/block.ts"
import { asUserError, userFacingAndGit } from "#cli/exit.ts"
import { lines, summary } from "#cli/findings.ts"
import { forPr, prArgument } from "#cli/pr.ts"
import { count } from "#cli/table.ts"
import { asMarkdown, jsonSchema, Reported } from "#domain/findings.ts"
import type { Reviewing } from "#domain/persona.ts"
import { turnFor } from "#domain/persona.ts"
import type { Asked, Outcome } from "#domain/review.ts"
import {
  LastReviewed,
  lastRun,
  latestKey,
  detailOf,
  reportDocument,
  reportedBy,
  reportKey,
  ReviewRun,
  runKey,
  short,
  skippedSince
} from "#domain/review.ts"
import type { ReviewTurn } from "#terms/review.ts"
import { Effort } from "#terms/review.ts"

/** What a review run has reached for so far, which is what its heartbeat counts. */
interface Doing {
  readonly tools: number
  readonly subagents: number
}

/** What the heartbeat says a run has got through, while it is still going. */
const saying =
  (doing: Doing): Reads =>
  (since) =>
    ["reviewing", count(doing.tools, "tool"), doing.subagents === 0 ? null : count(doing.subagents, "subagent"), since]
      .filter((part) => part !== null)
      .join(" · ")

const commandFlag = Flag.String("command").pipe(
  Flag.withDescription("The slash command this run opens on, over what the repository configured"),
  Flag.optional
)

const promptFlag = Flag.String("prompt").pipe(
  Flag.withDescription("The review instructions this run carries, over what the repository configured"),
  Flag.optional
)

const effortFlag = Flag.Literals("effort", Effort.literals).pipe(
  Flag.withDescription("How much this run spends, over what the repository configured"),
  Flag.optional
)

const modelFlag = Flag.String("model").pipe(
  Flag.withDescription("The model this run reads the code on, over what the repository configured"),
  Flag.optional
)

const promptOnlyFlag = Flag.Boolean("prompt-only").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Review on the prompt alone, whatever slash command the repository configured")
)

const commandOnlyFlag = Flag.Boolean("command-only").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Review on the slash command alone, whatever instructions the repository configured")
)

const forceFlag = Flag.Boolean("force").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Review even where the re-run rule would skip it")
)

/** A flag that names a value beside the flag that clears it: one of the two, never both. */
const opposite = (flag: string, given: Option.Option<string>, only: string) =>
  Option.isSome(given) ? [`--${flag} and --${only} say opposite things. Pass one.`] : []

/** What this run is asked, once the flags have had their say over the file. */
const asking = (options: {
  readonly settings: Settings
  readonly command: Option.Option<string>
  readonly prompt: Option.Option<string>
  readonly effort: Option.Option<Effort>
  readonly model: Option.Option<string>
  readonly promptOnly: boolean
  readonly commandOnly: boolean
}) => {
  const clash = [
    ...(options.promptOnly ? opposite("command", options.command, "prompt-only") : []),
    ...(options.commandOnly ? opposite("prompt", options.prompt, "command-only") : [])
  ]
  if (clash.length > 0) {
    return Effect.fail(new CliError.UserError({ cause: clash.join(" ") }))
  }

  const { review } = options.settings
  return Effect.succeed({
    command: options.promptOnly ? null : Option.getOrElse(options.command, () => review.command),
    effort: Option.getOrElse(options.effort, () => review.effort),
    prompt: options.commandOnly ? null : Option.getOrElse(options.prompt, () => review.prompt),
    model: Option.getOrElse(options.model, () => review.model)
  })
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

/** How a run reads on the line above it: what it opens on, and on which model. */
const spending = (turn: ReviewTurn, model: string | null): string =>
  [
    turn._tag === "command" ? turn.line : "the tool's own prompt",
    turn._tag === "command" && turn.instructions !== null ? "with my own instructions" : null,
    model === null ? null : `model ${model}`
  ]
    .filter((part) => part !== null)
    .join(", ")

/** What the review came back with, as far as the adapter itself gets. */
interface Reviewed {
  /** The session the run happened in. */
  readonly sessionId: string
  /** What the run said in prose, or null where a schema left it none to say. */
  readonly prose: string | null
  /**
   * The findings as they weighed, or whatever stopped them weighing: a turn
   * that could not report, and a turn that answered in a shape that does not
   * validate, are the same kind of failure of the same run.
   */
  readonly reported: Result.Result<typeof Reported.Type, { readonly message: string }>
}

/** What is written down about the review. */
interface Ran {
  readonly sessionId: string | null
  /** The prose the report document is written from, or null where there is none. */
  readonly prose: string | null
  readonly outcome: Outcome
}

/**
 * The review of the head in the worktree.
 *
 * Whatever the reporting comes to is a value and not a failure: the review is
 * already worth keeping, and a turn that could not report is recorded as the
 * failure it is rather than lost with it.
 */
const reviewOn = Effect.fn("review.reviewOn")(function* (options: {
  readonly launcher: Launcher
  readonly directory: string
  readonly turn: ReviewTurn
  readonly model: string | null
}) {
  const { directory, launcher, model, turn } = options
  // The count is the command's: a tool reached for moves it on, and the line is
  // reworded from where it got to. Where there is no screen the tools go out one
  // to a line, as they did before there was a heartbeat.
  let doing: Doing = { tools: 0, subagents: 0 }
  const run = yield* beating(saying(doing), (says) =>
    reviewTurns({
      launcher,
      directory,
      turn,
      model,
      jsonSchema,
      onTool: (tool) => {
        doing = { tools: doing.tools + 1, subagents: doing.subagents + (tool === "Agent" ? 1 : 0) }
        return says(saying(doing), indent(`· ${tool}`))
      }
    })
  )
  // Both halves answer `message`, which is all `ranBy` reads: a turn that could
  // not report and a turn that answered in a shape that does not validate are
  // the same kind of failure of the same run.
  const answered: Effect.Effect<unknown, { readonly message: string }> = Result.isFailure(run.findings)
    ? Effect.fail(run.findings.failure)
    : Effect.succeed(run.findings.success)
  const reported = yield* Effect.result(
    Effect.flatMap(answered, (output) => Schema.decodeUnknownEffect(Reported)(output))
  )
  return { sessionId: run.sessionId, prose: run.prose, reported } satisfies Reviewed
})

/**
 * What the review comes to on disk: the findings it reported, or the failure it
 * reached instead.
 *
 * A run that would not start is as much a failure as a turn that answered in a
 * shape that does not validate, and both are recorded: the head has been tried
 * and nothing was found, which is not the same as nothing being wrong.
 */
const ranBy = (got: Result.Result<Reviewed, AgentFailed>): Ran => {
  if (Result.isFailure(got)) {
    return { sessionId: null, prose: null, outcome: { _tag: "failed", detail: got.failure.detail } }
  }
  const { prose, reported, sessionId } = got.success
  if (Result.isFailure(reported)) {
    return { sessionId, prose, outcome: { _tag: "failed", detail: reported.failure.message } }
  }
  const found = reported.success
  return {
    sessionId,
    // A run held to a schema answers in findings and not in prose, so the report
    // kept beside it is written from what it found.
    prose: prose ?? asMarkdown(found),
    outcome: { _tag: "reported", verdict: found.verdict, findings: found.findings }
  }
}

/**
 * The command's own failure where the review reported nothing.
 *
 * The run is written down either way; what the exit code says is whether the
 * review I asked for is one to trust.
 */
const unreported = (run: ReviewRun, number: number) => {
  const detail = detailOf(run)
  return detail === null
    ? Effect.void
    : Effect.fail(
        new CliError.UserError({
          cause:
            `The review ran and its findings did not: ${detail}. ` +
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
 * reviewed is the pull request's head rather than whatever I have open.
 *
 * What it found is kept against that head, which is what takes the pull request
 * out of Needs review run and what a blocking finding later puts into Needs me.
 *
 * The report is printed as well as kept. A run I waited minutes for should not
 * need a second command to read.
 */
export const review = Command.make(
  "review",
  {
    pr: prArgument,
    command: commandFlag,
    prompt: promptFlag,
    effort: effortFlag,
    model: modelFlag,
    promptOnly: promptOnlyFlag,
    commandOnly: commandOnlyFlag,
    force: forceFlag
  },
  Effect.fn("review")(
    function* ({ command, commandOnly, effort, force, model, pr, prompt, promptOnly }) {
      const { number, repo, settings, launcher } = yield* forPr(pr)
      const asked = yield* asking({ settings, command, prompt, effort, model, promptOnly, commandOnly })

      const paint = yield* Paint
      const view = yield* prView(repo, number)
      yield* print([`${repo}#${number}  ${paint.dim(view.title)}`])

      const since = force
        ? null
        : skippedSince(yield* askedOf(repo, number, view.headRefOid), settings.review.docs_only)
      if (since !== null) {
        yield* print([
          indent(
            `only documentation changed since ${paint.dim(short(since))}, so this run is skipped. ` +
              `Pass --force to review it anyway.`
          )
        ])
        return
      }

      const about: Reviewing = {
        repo,
        number,
        title: view.title,
        base: view.baseRefName,
        prompt: asked.prompt
      }
      const turn = turnFor(asked, about)

      // The bell and the notification are what let me walk away from a run that
      // takes minutes, so they ring however it ended: a run that gave up while I
      // was elsewhere is the one I most need to hear about.
      yield* Effect.gen(function* () {
        const ran = yield* withWorktree(repo, number, (worktree) =>
          Effect.gen(function* () {
            yield* print([indent(`head ${paint.dim(short(worktree.head))}  ${spending(turn, asked.model)}`)])
            const got = yield* Effect.result(
              reviewOn({ launcher, directory: worktree.directory, turn, model: asked.model })
            )
            return { head: worktree.head, ran: ranBy(got) }
          })
        )

        const ranAt = yield* DateTime.now
        const runs = yield* storeFor("runs", ReviewRun)
        const latest = yield* storeFor("runs", LastReviewed)
        const reports = yield* textStoreFor("runs")

        const got = ran.ran
        const run: ReviewRun = {
          repo,
          number,
          head: ran.head,
          command: asked.command,
          effort: asked.command === null ? null : asked.effort,
          sessionId: got.sessionId,
          ranAt,
          outcome: got.outcome
        }
        yield* runs.set(runKey(repo, number, run.head), run)
        yield* latest.set(latestKey(repo, number), { head: run.head })
        yield* reports.set(reportKey(repo, number, run.head), reportDocument(run, view.title, got.prose ?? ""))

        const detail = detailOf(run)
        const found = detail === null ? reportedBy(run) : null
        yield* print(
          following([
            detail === null ? [] : [indent(`reported nothing: ${detail}`)],
            found === null || got.prose === null ? [] : [got.prose],
            found === null ? [] : block(summary(found, settings.stamp.blocks_on), lines(found, paint)),
            [`Recorded against ${paint.dim(short(ran.head))} in ${paint.dim(yield* stateDirectory)}`]
          ])
        )
        yield* unreported(run, number)
      }).pipe(
        Effect.onExit((exit) =>
          announce("dw-mc review", `${repo}#${number} ${Exit.isSuccess(exit) ? "reviewed" : "could not be reviewed"}`)
        )
      )
    },
    // No `AgentFailed` here: the run's own failure is caught where it happens
    // and written down as the run's outcome, so it never reaches this far.
    Effect.catchTag(userFacingAndGit, asUserError)
  )
).pipe(Command.withDescription("Review one pull request on Claude Code, in a throwaway worktree"))
