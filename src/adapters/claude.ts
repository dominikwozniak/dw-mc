/**
 * Claude Code: a review on a slash command, a review on the tool's own prompt,
 * and the sessions I steer.
 */
import { Effect, Option, PlatformError, Result, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

import type { Reported, AgentFailed } from "#adapters/agent.ts"
import { failedBy, patience, turn } from "#adapters/agent.ts"
import type { Launcher } from "#adapters/config.ts"
import type { ReviewTurn } from "#terms/review.ts"

/** What one turn came back with. */
export interface Turn {
  /** What the run said, as the prose it says it in. */
  readonly report: string
  /** The session the turn ran in, which the follow-up turn resumes. */
  readonly sessionId: string
}

/** What a whole review run came to, however many turns it took. */
export interface Reviewed {
  readonly sessionId: string
  /** What the run said in prose, or null where a schema left it none to say. */
  readonly prose: string | null
  /** What it reported, or the failure the reporting was. */
  readonly findings: Result.Result<unknown, AgentFailed>
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

const Ended = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  is_error: Schema.Boolean,
  session_id: Schema.String,
  result: Schema.optionalKey(Schema.String),
  /** What a turn given a JSON schema validated, which this hands on unread. */
  structured_output: Schema.optionalKey(Schema.Unknown)
})

const asWorking = Schema.decodeUnknownOption(Schema.fromJsonString(Working))
const asResult = Schema.decodeUnknownOption(Schema.fromJsonString(Ended))

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
  readonly result: Option.Option<typeof Ended.Type>
}

/**
 * The result a turn ended on, or the failure it really was.
 *
 * A turn that said nothing this can read and a turn Claude Code itself calls an
 * error are both failures: `subtype` is where a run that hit its turn limit or
 * lost its connection says so, and its `result` is the only word on why.
 */
const ended = (program: string, result: Option.Option<typeof Ended.Type>) => {
  const failed = failedBy(program)
  if (Option.isNone(result)) {
    return Effect.fail(failed("the turn came back with no result"))
  }
  const { is_error, result: lastWord, subtype } = result.value
  return is_error || subtype !== "success"
    ? Effect.fail(failed(`${subtype}: ${lastWord ?? "nothing else was said"}`))
    : Effect.succeed(result.value)
}

/**
 * A Claude Code `stream-json` turn, read as it arrives: what it reached for goes
 * to `onTool` while the run is still going, and what it said and how it ended
 * are what comes back.
 *
 * Both shapes of review read a turn the same way, so the fold is here rather
 * than once per shape.
 */
const transcript =
  (onTool: (tool: string) => Effect.Effect<void>) =>
  (stdout: ChildProcessSpawner.ChildProcessHandle["stdout"]): Effect.Effect<SoFar, PlatformError.PlatformError> =>
    stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapEffect((line) => {
        const heard = heardIn(line)
        return Effect.as(Effect.forEach(heard.tools, onTool, { discard: true }), { line, heard })
      }),
      Stream.runFold(
        (): SoFar => ({ said: [], result: Option.none() }),
        (soFar, { heard, line }): SoFar => ({
          said: [...soFar.said, ...heard.said],
          result: Option.orElse(asResult(line), () => soFar.result)
        })
      )
    )

/**
 * One review run on a slash command, headless, in `directory`.
 *
 * The run is in the foreground and says what it is doing as it does it, which
 * is what `onTool` is for: a review takes minutes, and a terminal that prints
 * nothing for minutes is one I stop trusting.
 *
 * `--json-schema` is never passed here: verified by running it, the flag beside
 * `/code-review` breaks the run, which is why a slash command costs a second
 * turn that resumes the session and asks for the findings. My own instructions
 * ride on `--append-system-prompt` rather than on the command's own line,
 * because what a slash command does with its arguments is its business and not
 * this tool's.
 *
 * `--comment` is the flag that makes the built-in review post on the pull
 * request, and it is never passed either (ADR 0002). The report is everything
 * the run said on its own turns rather than the `result` alone: verified by
 * running it, a repository whose review command fans out to subagents can end on
 * a remark about them, and the report is the turn before that.
 */
export const commandReview = Effect.fn("claude.commandReview")(function* (options: {
  readonly launcher: Launcher
  readonly directory: string
  readonly line: string
  readonly instructions: string | null
  readonly model: string | null
  readonly onTool: (tool: string) => Effect.Effect<void>
}) {
  const [program] = options.launcher.command
  const run = yield* turn({
    command: options.launcher.command,
    directory: options.directory,
    args: [
      "-p",
      options.line,
      "--output-format",
      "stream-json",
      "--verbose",
      ...(options.instructions === null ? [] : ["--append-system-prompt", options.instructions]),
      ...(options.model === null ? [] : ["--model", options.model])
    ],
    patience: { turn: "the review", duration: patience.reviewing },
    read: transcript(options.onTool)
  })

  const { result: lastWord, session_id } = yield* ended(program, run.result)

  // The result is the run's last word, which is its whole answer on a run that
  // said nothing before it.
  const report = (run.said.length === 0 ? (lastWord ?? "") : run.said.join("\n\n")).trim()
  if (report === "") {
    return yield* failedBy(program)("the run came back with an empty report")
  }
  return { report, sessionId: session_id } satisfies Turn
}, Effect.scoped)

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
 * domain, and the schema the run is held to comes in from there too.
 *
 * Every way this can end badly ends as an `AgentFailed`, because a review run
 * that could not report is a failure and never a clean verdict.
 */
export const findingsTurn = Effect.fn("claude.findingsTurn")(function* (options: {
  readonly launcher: Launcher
  readonly directory: string
  readonly sessionId: string
  readonly jsonSchema: string
}) {
  const [program] = options.launcher.command
  const printed = yield* turn({
    command: options.launcher.command,
    directory: options.directory,
    patience: { turn: "the findings turn", duration: patience.reporting },
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

  const { structured_output } = yield* ended(program, asResult(printed.trim()))
  if (structured_output === undefined) {
    return yield* failedBy(program)("the findings turn came back with no structured output")
  }
  return structured_output
}, Effect.scoped)

/**
 * One review run of the tool's own review prompt, in `directory`.
 *
 * It is one turn rather than two: verified by running it, `--json-schema` beside
 * an ordinary prompt gives both the prose the run wrote and the
 * `structured_output` it validated, where the same flag on a slash command
 * breaks the run. The schema arrives as inline JSON and never as a path - a path
 * is where Claude Code reports `--json-schema is not valid JSON`.
 */
export const promptReview = Effect.fn("claude.promptReview")(function* (options: {
  readonly launcher: Launcher
  readonly directory: string
  readonly prompt: string
  /** The model to run the prompt on, or null for whatever the CLI would pick. */
  readonly model: string | null
  readonly jsonSchema: string
  readonly onTool: (tool: string) => Effect.Effect<void>
}) {
  const [program] = options.launcher.command
  const run = yield* turn({
    command: options.launcher.command,
    directory: options.directory,
    patience: { turn: "the review", duration: patience.reviewing },
    args: [
      "-p",
      options.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      options.jsonSchema,
      ...(options.model === null ? [] : ["--model", options.model])
    ],
    read: transcript(options.onTool)
  })

  const { session_id, structured_output } = yield* ended(program, run.result)
  if (structured_output === undefined) {
    return yield* failedBy(program)("the review came back with no structured output")
  }

  const prose = run.said.join("\n\n").trim()
  return { findings: structured_output, sessionId: session_id, prose: prose === "" ? null : prose } satisfies Reported
}, Effect.scoped)

/**
 * One review run, in whichever shape it was configured in.
 *
 * A slash command takes two turns and the tool's own prompt takes one, which is
 * Claude Code's doing and nobody else's: a caller hands over the turn and gets
 * the same answer back either way.
 *
 * The second turn's failure is kept beside the first turn's prose rather than
 * replacing it. A review that ran and could not report is still worth reading,
 * and it is recorded as the failure it is.
 */
export const reviewTurns = Effect.fn("claude.reviewTurns")(function* (options: {
  readonly launcher: Launcher
  readonly directory: string
  readonly turn: ReviewTurn
  readonly model: string | null
  readonly jsonSchema: string
  readonly onTool: (tool: string) => Effect.Effect<void>
}) {
  const { directory, jsonSchema, launcher, model, onTool } = options
  if (options.turn._tag === "prompt") {
    const run = yield* promptReview({ launcher, directory, prompt: options.turn.text, model, jsonSchema, onTool })
    return { sessionId: run.sessionId, prose: run.prose, findings: Result.succeed(run.findings) } satisfies Reviewed
  }

  const run = yield* commandReview({
    launcher,
    directory,
    line: options.turn.line,
    instructions: options.turn.instructions,
    model,
    onTool
  })
  const findings = yield* Effect.result(findingsTurn({ launcher, directory, sessionId: run.sessionId, jsonSchema }))
  return { sessionId: run.sessionId, prose: run.report, findings } satisfies Reviewed
})

/**
 * An interactive `claude` in `directory`, opened on `prompt`, with my terminal
 * handed straight to it.
 *
 * The launcher's `fix_args` go here and nowhere else: they are the flags of
 * every session I steer - the one on findings and the one on a conflict - which
 * no headless review turn wants. They sit in front of the
 * prompt, because `claude` takes its flags before its positional argument.
 *
 * This is the one place a run is not read: the three streams are inherited,
 * so what is on the screen is the session itself and not a transcript of it,
 * and what I type reaches it. The child is not detached for the same reason -
 * a detached child sits outside the terminal's foreground process group, where
 * neither my keystrokes nor Ctrl-C would reach it.
 *
 * There is no patience here either. A session I steer lasts as long as I am in
 * it, and a timeout would be the tool closing a session I was still working in.
 *
 * What comes back is the code the session ended on. A session I left with
 * Ctrl-C ended badly for `claude` and not for me, so this reports it rather
 * than failing on it; only a `claude` that would not start at all is a failure.
 */
export const steeredSession = Effect.fn("claude.steeredSession")(function* (options: {
  readonly launcher: Launcher
  readonly directory: string
  readonly prompt: string
}) {
  const [program, ...prefix] = options.launcher.command
  const failed = failedBy(program)
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const handle = yield* Effect.mapError(
    spawner.spawn(
      ChildProcess.make(program, [...prefix, ...options.launcher.fix_args, options.prompt], {
        cwd: options.directory,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        detached: false
      })
    ),
    (error) => failed(error.message)
  )

  return yield* Effect.mapError(handle.exitCode, (error) => failed(error.message))
}, Effect.scoped)
