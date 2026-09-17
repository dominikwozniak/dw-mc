import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect"

import type { Reported } from "#adapters/agent.ts"
import { failedBy, patience, turn } from "#adapters/agent.ts"
import type { Launcher } from "#adapters/config.ts"

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
 * A filesystem that hands Codex a schema file without touching the disk, and
 * records what was written to it.
 *
 * Writing that file is the one thing a review run writes anywhere, so the seam
 * ships its own double: a caller's test gets the runner and the filesystem it
 * needs from one import (ADR 0006).
 */
export const layerFakeSchemaFile = (
  written: Array<readonly [string, string]> = [],
  path = "/tmp/dw-mc-findings-1.json"
): Layer.Layer<FileSystem.FileSystem> =>
  FileSystem.layerNoop({
    makeTempFileScoped: () => Effect.succeed(path),
    writeFileString: (to, contents) => Effect.sync(() => written.push([to, contents]))
  })
