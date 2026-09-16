import { Duration, Effect, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

import type { Effort } from "#adapters/config.ts"

/** A review run that would not start, would not finish, or finished badly. */
export class RunnerFailed extends Schema.TaggedError<RunnerFailed>()("RunnerFailed", {
  runner: Schema.String,
  detail: Schema.String
}) {
  override get message(): string {
    return `The ${this.runner} review run failed: ${this.detail}`
  }
}

/** What one turn on a runner came back with. */
export interface Turn {
  /** What the runner said, as the prose it says it in. */
  readonly report: string
  /** The session the turn ran in, which the follow-up turn resumes. */
  readonly sessionId: string
}

/**
 * The two events of a stream-json run this reads, as the runner really writes
 * them. Every other field of both, and every other event, is ignored: a
 * transcript carries hooks, rate limits, thinking and tool results, and a
 * version that adds another must not stop a run from being read.
 */
const Working = Schema.Struct({
  type: Schema.Literal("assistant"),
  message: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        name: Schema.optionalKey(Schema.String),
        text: Schema.optionalKey(Schema.String)
      })
    )
  })
})

const Result = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  is_error: Schema.Boolean,
  session_id: Schema.String,
  result: Schema.optionalKey(Schema.String),
  /** What a turn given a JSON schema validated, which this hands on unread. */
  structured_output: Schema.optionalKey(Schema.Unknown)
})

const asWorking = Schema.decodeUnknownOption(Schema.fromJsonString(Working))
const asResult = Schema.decodeUnknownOption(Schema.fromJsonString(Result))

/** What one event says the runner reached for, and what it said out loud. */
interface Heard {
  readonly tools: ReadonlyArray<string>
  readonly said: ReadonlyArray<string>
}

const heardIn = (line: string): Heard => {
  const blocks = Option.match(asWorking(line), { onNone: () => [], onSome: (event) => event.message.content })
  return {
    tools: blocks.flatMap((block) => (block.type === "tool_use" && block.name !== undefined ? [block.name] : [])),
    said: blocks.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
  }
}

/** What the run comes to while it is still going. */
interface SoFar {
  readonly said: ReadonlyArray<string>
  readonly result: Option.Option<typeof Result.Type>
}

const failed = (detail: string) => new RunnerFailed({ runner: "claude", detail })

/**
 * How long each turn gets before it is given up on.
 *
 * The review is the turn that thinks, and a high-effort one that fans out to
 * subagents takes real minutes, so its limit is there to catch a runner that has
 * stopped rather than one that is slow. The second turn reads no code and
 * decides nothing - the review it reports on is already in the session it
 * resumes - and every run of it by hand came back in seconds.
 *
 * Either way, a command that hangs forever is worse than one that says it
 * failed: a review I walked away from is one I need to be able to come back to.
 */
const patience = {
  reviewing: Duration.minutes(45),
  reporting: Duration.minutes(5)
}

/**
 * One turn of `claude` in `directory`, with `read` over its standard output.
 *
 * The two output streams are drained together, because draining one to the end
 * first can block a runner that is still writing to the other. Every way a turn
 * can fail to finish comes back from here as a `RunnerFailed`, so a caller is
 * left with the turn's own answer and nothing else to translate.
 */
const turn = Effect.fnUntraced(function* <A, E extends { readonly message: string }, R>(options: {
  readonly directory: string
  readonly args: ReadonlyArray<string>
  readonly read: (stdout: ChildProcessSpawner.ChildProcessHandle["stdout"]) => Effect.Effect<A, E, R>
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const handle = yield* Effect.mapError(
    spawner.spawn(ChildProcess.make("claude", options.args, { cwd: options.directory })),
    (error) => failed(error.message)
  )

  const [got, stderr] = yield* Effect.mapError(
    Effect.all([options.read(handle.stdout), Stream.mkString(Stream.decodeText(handle.stderr))], { concurrency: 2 }),
    (error) => failed(error.message)
  )

  const exitCode = yield* Effect.mapError(handle.exitCode, (error) => failed(error.message))
  if (exitCode !== 0) {
    return yield* failed(stderr.trim() === "" ? `claude exited ${exitCode}` : stderr.trim())
  }
  return got
})

/**
 * The result a turn ended on, or the failure it really was.
 *
 * A turn that said nothing this can read and a turn the runner itself calls an
 * error are both failures: `subtype` is where a run that hit its turn limit or
 * lost its connection says so, and its `result` is the only word on why.
 */
const ended = (result: Option.Option<typeof Result.Type>) => {
  if (Option.isNone(result)) {
    return Effect.fail(failed("the turn came back with no result"))
  }
  const { is_error, result: lastWord, subtype } = result.value
  return is_error || subtype !== "success"
    ? Effect.fail(failed(`${subtype}: ${lastWord ?? "nothing else was said"}`))
    : Effect.succeed(result.value)
}

/**
 * One review run of Claude Code's own code review, headless, in `directory`.
 *
 * The run is in the foreground and says what it is doing as it does it, which
 * is what `onTool` is for: a review takes minutes, and a terminal that prints
 * nothing for minutes is one I stop trusting.
 *
 * `--comment` is the flag that makes the built-in review post on the pull
 * request, and it is never passed (ADR 0002). The report is everything the
 * runner said on its own turns rather than the `result` alone: verified by
 * running it, a repository whose review command fans out to subagents can end
 * on a remark about them, and the report is the turn before that. The follow-up
 * turn is what turns the prose into findings, and it needs this run's session.
 */
export const builtinReview = Effect.fn("runner.builtinReview")(
  function* (options: {
    readonly directory: string
    readonly effort: Effort
    readonly onTool: (tool: string) => Effect.Effect<void>
  }) {
    const run = yield* turn({
      directory: options.directory,
      args: ["-p", `/code-review ${options.effort}`, "--output-format", "stream-json", "--verbose"],
      read: (stdout) =>
        stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.mapEffect((line) => {
            const heard = heardIn(line)
            return Effect.as(Effect.forEach(heard.tools, options.onTool, { discard: true }), { line, heard })
          }),
          Stream.runFold(
            (): SoFar => ({ said: [], result: Option.none() }),
            (soFar, { heard, line }): SoFar => ({
              said: [...soFar.said, ...heard.said],
              result: Option.orElse(asResult(line), () => soFar.result)
            })
          )
        )
    })

    const { result: lastWord, session_id } = yield* ended(run.result)

    // The result is the runner's last word, which is its whole answer on a run
    // that said nothing before it.
    const report = (run.said.length === 0 ? (lastWord ?? "") : run.said.join("\n\n")).trim()
    if (report === "") {
      return yield* failed("the run came back with an empty report")
    }
    return { report, sessionId: session_id } satisfies Turn
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: patience.reviewing,
    orElse: () => failed(`the review did not come back within ${Duration.format(patience.reviewing)}`)
  })
)

/**
 * What the second turn asks for.
 *
 * It asks for a report of what was already said rather than for another look:
 * the prose is the review, and this turn is only what makes it machine
 * readable. The shape it must answer in arrives as a JSON schema beside it, so
 * the prompt does not describe the schema twice.
 */
const reportFindings = [
  "Report the findings of the review you just gave as structured output.",
  "Every finding carries the file it is in as a repository path, the line it is at,",
  "its severity and a one-sentence summary.",
  "The verdict is clean when there is nothing to report and findings otherwise.",
  "Report nothing you did not already say."
].join(" ")

/**
 * The second turn of a review run: the prose the first one wrote, back as
 * findings that validate.
 *
 * It resumes the first turn's session rather than reading the diff again, which
 * is what makes it cheap and what makes it accurate - verified by running it,
 * the line numbers it reports beat the ones the prose gives. The output is
 * handed on as it arrived: what the findings must look like belongs to the
 * domain, and the schema the runner is held to comes in from there too.
 *
 * Every way this can end badly ends as a `RunnerFailed`, because a review run
 * that could not report is a failure and never a clean verdict.
 */
export const builtinFindings = Effect.fn("runner.builtinFindings")(
  function* (options: { readonly directory: string; readonly sessionId: string; readonly jsonSchema: string }) {
    const printed = yield* turn({
      directory: options.directory,
      args: [
        "-p",
        "--resume",
        options.sessionId,
        reportFindings,
        "--output-format",
        "json",
        "--json-schema",
        options.jsonSchema
      ],
      read: (stdout) => Stream.mkString(Stream.decodeText(stdout))
    })

    const { structured_output } = yield* ended(asResult(printed.trim()))
    if (structured_output === undefined) {
      return yield* failed("the findings turn came back with no structured output")
    }
    return structured_output
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: patience.reporting,
    orElse: () => failed(`the findings turn did not come back within ${Duration.format(patience.reporting)}`)
  })
)
