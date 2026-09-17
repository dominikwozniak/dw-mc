import { Duration, Effect, FileSystem, Option, PlatformError, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

import type { Effort, Launcher, Runner } from "#adapters/config.ts"

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

/**
 * Failures in the name of the program that was spawned.
 *
 * Where the launcher starts `claude` through another program, it is that
 * program that would not start or exited badly, and saying `claude` sends the
 * search to the wrong process.
 */
const failedBy = (program: string) => (detail: string) => new RunnerFailed({ runner: program, detail })

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
 * One turn of the launcher in `directory`, with `read` over its standard output.
 *
 * The launcher's own arguments go in front of the turn's, because they are what
 * gets `claude` started at all. The two output streams are drained together,
 * because draining one to the end first can block a runner that is still writing
 * to the other. Every way a turn can fail to finish comes back from here as a
 * `RunnerFailed`, so a caller is left with the turn's own answer and nothing else
 * to translate - a turn that never comes back included.
 */
const turn = Effect.fnUntraced(function* <A, E extends { readonly message: string }, R>(options: {
  /** The program and the prefix that starts this turn's CLI. */
  readonly command: readonly [string, ...Array<string>]
  readonly directory: string
  readonly args: ReadonlyArray<string>
  /** What this turn is called when it is late, and how long it has. */
  readonly patience: { readonly turn: string; readonly duration: Duration.Duration }
  /**
   * What the turn's standard input is. The default pipe suits a CLI that never
   * reads it; `codex exec` reads standard input to the end and appends it to
   * the prompt, so a pipe nothing closes is a run that never starts thinking.
   */
  readonly stdin?: "pipe" | "ignore" | undefined
  readonly read: (stdout: ChildProcessSpawner.ChildProcessHandle["stdout"]) => Effect.Effect<A, E, R>
}) {
  const [program, ...prefix] = options.command
  const failed = failedBy(program)
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const running = Effect.gen(function* () {
    const handle = yield* Effect.mapError(
      spawner.spawn(
        ChildProcess.make(program, [...prefix, ...options.args], {
          cwd: options.directory,
          stdin: options.stdin ?? "pipe"
        })
      ),
      (error) => failed(error.message)
    )

    const [got, stderr] = yield* Effect.mapError(
      Effect.all([options.read(handle.stdout), Stream.mkString(Stream.decodeText(handle.stderr))], { concurrency: 2 }),
      (error) => failed(error.message)
    )

    const exitCode = yield* Effect.mapError(handle.exitCode, (error) => failed(error.message))
    if (exitCode !== 0) {
      return yield* failed(stderr.trim() === "" ? `${program} exited ${exitCode}` : stderr.trim())
    }
    return got
  })

  return yield* Effect.timeoutOrElse(running, {
    duration: options.patience.duration,
    orElse: () =>
      failed(`${options.patience.turn} did not come back within ${Duration.format(options.patience.duration)}`)
  })
})

/**
 * The result a turn ended on, or the failure it really was.
 *
 * A turn that said nothing this can read and a turn the runner itself calls an
 * error are both failures: `subtype` is where a run that hit its turn limit or
 * lost its connection says so, and its `result` is the only word on why.
 */
const ended = (program: string, result: Option.Option<typeof Result.Type>) => {
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
 * Both of Claude Code's runners read a turn the same way, so the fold is here
 * rather than once per runner.
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
export const builtinReview = Effect.fn("runner.builtinReview")(function* (options: {
  readonly launcher: Launcher
  readonly directory: string
  readonly effort: Effort
  readonly onTool: (tool: string) => Effect.Effect<void>
}) {
  const [program] = options.launcher.command
  const run = yield* turn({
    command: options.launcher.command,
    directory: options.directory,
    args: ["-p", `/code-review ${options.effort}`, "--output-format", "stream-json", "--verbose"],
    patience: { turn: "the review", duration: patience.reviewing },
    read: transcript(options.onTool)
  })

  const { result: lastWord, session_id } = yield* ended(program, run.result)

  // The result is the runner's last word, which is its whole answer on a run
  // that said nothing before it.
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
 * domain, and the schema the runner is held to comes in from there too.
 *
 * Every way this can end badly ends as a `RunnerFailed`, because a review run
 * that could not report is a failure and never a clean verdict.
 */
export const builtinFindings = Effect.fn("runner.builtinFindings")(function* (options: {
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

/** What one `prompt` review run came back with, on either CLI. */
export interface Reported {
  /** What the run validated against the schema, handed on unread. */
  readonly findings: unknown
  /** The session the run happened in, which is what a run is recorded against. */
  readonly sessionId: string
  /** What the run said in prose beside its findings, or null where it said none. */
  readonly prose: string | null
}

/**
 * One review run of the tool's own review prompt on Claude Code, in `directory`.
 *
 * It is one turn rather than two: verified by running it, `--json-schema`
 * beside an ordinary prompt gives both the prose the run wrote and the
 * `structured_output` it validated, where the same flag on the built-in
 * `/code-review` breaks the run. The schema arrives as inline JSON and never as
 * a path - a path is where Claude Code reports `--json-schema is not valid
 * JSON`.
 *
 * `review.model` reaches the run here, and nowhere in the built-in runner: the
 * prompt is the tool's, so which model reads the code is mine to choose.
 */
export const promptReview = Effect.fn("runner.promptReview")(function* (options: {
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
 * The events of a `codex exec --json` run this reads, as it really writes them.
 *
 * Every other field and every other event is ignored, the same way the Claude
 * Code transcript is read: a run carries reasoning, tool results and a usage
 * report, and a Codex version that adds another event must not stop a run from
 * being read.
 */
const CodexEvent = Schema.Struct({
  type: Schema.String,
  /** On `thread.started`: the session the run happens in. */
  thread_id: Schema.optionalKey(Schema.String),
  item: Schema.optionalKey(
    Schema.Struct({
      type: Schema.String,
      /** On an `agent_message`: what the run answered, which the schema makes JSON. */
      text: Schema.optionalKey(Schema.String)
    })
  )
})

const asCodexEvent = Schema.decodeUnknownOption(Schema.fromJsonString(CodexEvent))

/**
 * What Codex reached for, as the item types it reports it in.
 *
 * A run says it is alive by what it does, and what Codex does is run shell
 * commands, change files and call tools. Its own words for those are what the
 * progress line prints, so nothing here has to pretend Codex is Claude Code.
 */
const codexTool: Record<string, string> = {
  command_execution: "shell",
  file_change: "edit",
  mcp_tool_call: "tool",
  web_search: "search"
}

/** What a Codex run comes to while it is still going. */
interface CodexSoFar {
  readonly thread: Option.Option<string>
  readonly said: ReadonlyArray<string>
}

/**
 * One review run of the same prompt on the Codex CLI, in `directory`.
 *
 * This is the second opinion, so it answers the same schema and is recorded as
 * the same review run: everything downstream - the stamp, the buckets, `dw-mc
 * findings`, a fix session - cannot tell which CLI read the code.
 *
 * Codex takes its schema as a file and never inline, which is the mirror image
 * of Claude Code, so the schema is written to a temporary file that lives as
 * long as the run. Standard input is closed because `codex exec` reads it to
 * the end and appends it to the prompt. The sandbox is read-only: a review
 * reads, and a review run of mine has no business writing in the worktree it
 * was cut into.
 *
 * There is no prose: with a schema in force every message Codex sends is the
 * JSON the schema describes, so what it found is all there is, and the report
 * kept beside the run is written from the findings themselves.
 */
export const codexReview = Effect.fn("runner.codexReview")(function* (options: {
  readonly launcher: Launcher
  readonly directory: string
  readonly prompt: string
  readonly model: string | null
  readonly jsonSchema: string
  readonly onTool: (tool: string) => Effect.Effect<void>
}) {
  const [program] = options.launcher.codex
  const failed = failedBy(program)

  const fs = yield* FileSystem.FileSystem
  const schemaFile = yield* Effect.mapError(
    fs.makeTempFileScoped({ prefix: "dw-mc-findings-", suffix: ".json" }),
    (error) => failed(error.message)
  )
  yield* Effect.mapError(fs.writeFileString(schemaFile, options.jsonSchema), (error) => failed(error.message))

  const run = yield* turn({
    command: options.launcher.codex,
    directory: options.directory,
    patience: { turn: "the review", duration: patience.reviewing },
    stdin: "ignore",
    args: [
      "exec",
      "--json",
      "--output-schema",
      schemaFile,
      "--sandbox",
      "read-only",
      ...(options.model === null ? [] : ["--model", options.model]),
      options.prompt
    ],
    read: (stdout) =>
      stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapEffect((line) => {
          const event = asCodexEvent(line)
          const reached =
            Option.isSome(event) && event.value.type === "item.started"
              ? codexTool[event.value.item?.type ?? ""]
              : undefined
          return Effect.as(reached === undefined ? Effect.void : options.onTool(reached), event)
        }),
        Stream.runFold(
          (): CodexSoFar => ({ thread: Option.none(), said: [] }),
          (soFar, event): CodexSoFar => {
            if (Option.isNone(event)) {
              return soFar
            }
            const { item, thread_id, type } = event.value
            const said =
              type === "item.completed" && item?.type === "agent_message" && item.text !== undefined
                ? [...soFar.said, item.text]
                : soFar.said
            return { thread: Option.orElse(Option.fromUndefinedOr(thread_id), () => soFar.thread), said }
          }
        )
      )
  })

  if (Option.isNone(run.thread)) {
    return yield* failed("the run never said which thread it was in")
  }
  // The answer is the last thing the run said: with a schema in force Codex may
  // answer more than once, and what it settled on is the message it ended with.
  const answer = run.said.at(-1)
  if (answer === undefined) {
    return yield* failed("the run came back with no structured output")
  }

  // A schema here would be the findings' schema written a second time: what a
  // runner answers is handed on unread, and `#domain/findings.ts` is what
  // validates it. `Schema.UnknownFromJsonString` would do the same parse and
  // put `any` in the requirements channel, which the linter likes less.
  const findings = yield* Effect.try({
    // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
    try: (): unknown => JSON.parse(answer),
    catch: () => failed("the run answered in something that is not JSON")
  })
  return { findings, sessionId: run.thread.value, prose: null } satisfies Reported
}, Effect.scoped)

/**
 * The tool's own review prompt, on whichever CLI the runner names.
 *
 * The two CLIs are spawned differently and answer differently, and which of
 * them a runner means is the adapter's knowledge: a caller hands over the
 * runner and gets the same `Reported` back either way.
 */
export const promptRun = (options: {
  readonly runner: Runner
  readonly launcher: Launcher
  readonly directory: string
  readonly prompt: string
  readonly model: string | null
  readonly jsonSchema: string
  readonly onTool: (tool: string) => Effect.Effect<void>
}): Effect.Effect<Reported, RunnerFailed, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> =>
  options.runner === "codex" ? codexReview(options) : promptReview(options)

/**
 * An interactive `claude` in `directory`, opened on `prompt`, with my terminal
 * handed straight to it.
 *
 * The launcher's `fix_args` go here and nowhere else: they are the flags of
 * every session I steer - the one on findings and the one on a conflict - which
 * no headless review turn wants. They sit in front of the
 * prompt, because `claude` takes its flags before its positional argument.
 *
 * This is the one place a runner is not read: the three streams are inherited,
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
export const steeredSession = Effect.fn("runner.steeredSession")(function* (options: {
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
