import { Effect, Option, Schema, Stream } from "effect"
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
    content: Schema.Array(Schema.Struct({ type: Schema.String, name: Schema.optionalKey(Schema.String) }))
  })
})

const Result = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  is_error: Schema.Boolean,
  session_id: Schema.String,
  result: Schema.optionalKey(Schema.String)
})

const asWorking = Schema.decodeUnknownOption(Schema.fromJsonString(Working))
const asResult = Schema.decodeUnknownOption(Schema.fromJsonString(Result))

/** The tools one event reports the runner reaching for. */
const toolsIn = (line: string): ReadonlyArray<string> =>
  Option.match(asWorking(line), {
    onNone: () => [],
    onSome: (event) =>
      event.message.content.flatMap((block) =>
        block.type === "tool_use" && block.name !== undefined ? [block.name] : []
      )
  })

const failed = (detail: string) => new RunnerFailed({ runner: "claude", detail })

/**
 * One review run of Claude Code's own code review, headless, in `directory`.
 *
 * The run is in the foreground and says what it is doing as it does it, which
 * is what `onTool` is for: a review takes minutes, and a terminal that prints
 * nothing for minutes is one I stop trusting.
 *
 * `--comment` is the flag that makes the built-in review post on the pull
 * request, and it is never passed (ADR 0002). The report comes back as prose;
 * the follow-up turn is what turns it into findings, and it needs the session
 * this one ran in.
 *
 * The two output streams are drained together, because draining one to the end
 * first can block a runner that is still writing to the other.
 */
export const builtinReview = Effect.fn("runner.builtinReview")(function* (options: {
  readonly directory: string
  readonly effort: Effort
  readonly onTool: (tool: string) => Effect.Effect<void>
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const args = ["-p", `/code-review ${options.effort}`, "--output-format", "stream-json", "--verbose"]

  const handle = yield* Effect.mapError(
    spawner.spawn(ChildProcess.make("claude", args, { cwd: options.directory })),
    (error) => failed(error.message)
  )

  const [result, stderr] = yield* Effect.mapError(
    Effect.all(
      [
        handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.tap((line) => Effect.forEach(toolsIn(line), options.onTool, { discard: true })),
          Stream.runFold(
            () => Option.none<typeof Result.Type>(),
            (last, line) => Option.orElse(asResult(line), () => last)
          )
        ),
        Stream.mkString(Stream.decodeText(handle.stderr))
      ],
      { concurrency: 2 }
    ),
    (error) => failed(error.message)
  )

  const exitCode = yield* Effect.mapError(handle.exitCode, (error) => failed(error.message))
  if (exitCode !== 0) {
    return yield* failed(stderr.trim() === "" ? `claude exited ${exitCode}` : stderr.trim())
  }
  if (Option.isNone(result)) {
    return yield* failed("the run ended with no result")
  }

  const { is_error, result: prose, session_id, subtype } = result.value
  if (is_error || subtype !== "success") {
    return yield* failed(`${subtype}: ${prose ?? "nothing else was said"}`)
  }
  if (prose === undefined || prose.trim() === "") {
    return yield* failed("the run came back with an empty report")
  }
  return { report: prose.trim(), sessionId: session_id } satisfies Turn
}, Effect.scoped)
