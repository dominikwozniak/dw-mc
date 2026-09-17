import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { ChildProcess } from "effect/unstable/process"

import { codexReview, layerFakeSchemaFile } from "#adapters/codex.ts"
import { builtInLauncher } from "#adapters/config.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"

const launcher = builtInLauncher
const nothing = () => Effect.void

/** A `codex` that prints `stdout` and records how it was spawned. */
const spawning = (options: {
  readonly spawned: Array<ChildProcess.StandardCommand>
  readonly stdout?: string | undefined
  readonly stderr?: string | undefined
  readonly exitCode?: number | undefined
}) =>
  layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("codex.test: the fake was handed a piped command")
    }
    options.spawned.push(command)
    return Effect.succeed(
      fakeHandle({ stdout: options.stdout ?? "", stderr: options.stderr, exitCode: options.exitCode })
    )
  })

describe("the prompt runner on Codex", () => {
  const schema = `{"type":"object","properties":{"verdict":{"type":"string"}}}`
  const prompt = "You are an experienced staff engineer conducting a thorough code review."
  const thread = "01a0aebf-ef88-7432-b0d9-52a2f66480e1"
  const found = {
    verdict: "findings",
    findings: [{ file: "a.js", line: 2, severity: "error", summary: "`y` is not defined." }]
  }

  /** The events `codex exec --json --output-schema` really emits, in the order it emits them. */
  const events = (said: ReadonlyArray<unknown>) =>
    [
      { type: "thread.started", thread_id: thread },
      { type: "item.completed", item: { id: "item_0", type: "error", message: "clamping SessionEnd hook timeout" } },
      { type: "turn.started" },
      { type: "item.started", item: { id: "item_1", type: "command_execution", command: "nl -ba a.js" } },
      { type: "item.completed", item: { id: "item_1", type: "command_execution", exit_code: 0 } },
      ...said.map((answer) => ({
        type: "item.completed",
        item: { id: "item_2", type: "agent_message", text: JSON.stringify(answer) }
      })),
      { type: "turn.completed", usage: { input_tokens: 39129 } }
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")

  /** A machine with a `codex` that prints `stdout`, and the schema file it is handed. */
  const machine = (options: {
    readonly spawned: Array<ChildProcess.StandardCommand>
    readonly stdout?: string | undefined
    readonly stderr?: string | undefined
    readonly exitCode?: number | undefined
    readonly written: Array<readonly [string, string]>
  }) => Layer.mergeAll(spawning(options), layerFakeSchemaFile(options.written))

  const running = (over: { readonly model?: string | null } = {}) =>
    codexReview({
      launcher,
      directory: "/worktree",
      prompt,
      model: over.model ?? null,
      jsonSchema: schema,
      onTool: nothing
    })

  it.effect("runs the same prompt against the same schema, and hands the findings on", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const written: Array<readonly [string, string]> = []

    return Effect.gen(function* () {
      const reported = yield* running()

      assert.deepStrictEqual(reported, { findings: found, sessionId: thread, prose: null })
      assert.deepStrictEqual(
        spawned.map((command) => [command.command, ...command.args]),
        [["codex", "exec", "--json", "--output-schema", "/tmp/dw-mc-findings-1.json", "--sandbox", "read-only", prompt]]
      )
      assert.strictEqual(spawned[0]?.options.cwd, "/worktree")
    }).pipe(Effect.provide(machine({ spawned, stdout: events([found]), written })))
  })

  it.effect("hands Codex the schema in a file, because Codex takes no schema inline", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const written: Array<readonly [string, string]> = []

    return Effect.gen(function* () {
      yield* running()

      assert.deepStrictEqual(written, [["/tmp/dw-mc-findings-1.json", schema]])
    }).pipe(Effect.provide(machine({ spawned, stdout: events([found]), written })))
  })

  it.effect("closes standard input, which codex exec would otherwise read to the end", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const written: Array<readonly [string, string]> = []

    return Effect.gen(function* () {
      yield* running()

      assert.strictEqual(spawned[0]?.options.stdin, "ignore")
    }).pipe(Effect.provide(machine({ spawned, stdout: events([found]), written })))
  })

  it.effect("runs the prompt on the model the repository configured", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const written: Array<readonly [string, string]> = []

    return Effect.gen(function* () {
      yield* running({ model: "gpt-5.4-codex" })

      assert.deepStrictEqual(spawned[0]?.args.slice(-3), ["--model", "gpt-5.4-codex", prompt])
    }).pipe(Effect.provide(machine({ spawned, stdout: events([found]), written })))
  })

  it.effect("takes the last thing the run said, because a schema lets it answer more than once", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const written: Array<readonly [string, string]> = []

    return Effect.gen(function* () {
      const reported = yield* running()

      assert.deepStrictEqual(reported.findings, found)
    }).pipe(Effect.provide(machine({ spawned, stdout: events([{ verdict: "clean", findings: [] }, found]), written })))
  })

  it.effect("says what the run is reaching for, in Codex's own words for it", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const written: Array<readonly [string, string]> = []
    const tools: Array<string> = []

    return Effect.gen(function* () {
      yield* codexReview({
        launcher,
        directory: "/worktree",
        prompt,
        model: null,
        jsonSchema: schema,
        onTool: (tool) => Effect.sync(() => tools.push(tool))
      })

      assert.deepStrictEqual(tools, ["shell"])
    }).pipe(Effect.provide(machine({ spawned, stdout: events([found]), written })))
  })

  it.effect("a run that answered nothing is a failure, never a clean verdict", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const written: Array<readonly [string, string]> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(running())

      assert.strictEqual(error._tag, "RunnerFailed")
      assert.include(error.message, "no structured output")
    }).pipe(Effect.provide(machine({ spawned, stdout: events([]), written })))
  })

  it.effect("a run that answered something that is not JSON is a failure", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const written: Array<readonly [string, string]> = []
    const prose = JSON.stringify({
      type: "item.completed",
      item: { id: "item_2", type: "agent_message", text: "Looks fine to me." }
    })

    return Effect.gen(function* () {
      const error = yield* Effect.flip(running())

      assert.strictEqual(error._tag, "RunnerFailed")
      assert.include(error.message, "not JSON")
    }).pipe(
      Effect.provide(
        machine({
          spawned,
          stdout: `${JSON.stringify({ type: "thread.started", thread_id: thread })}\n${prose}`,
          written
        })
      )
    )
  })

  it.effect("a codex that exits non-zero is a failure in the name of codex", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const written: Array<readonly [string, string]> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(running())

      assert.strictEqual(error._tag, "RunnerFailed")
      assert.strictEqual(error.runner, "codex")
      assert.include(error.message, "Not logged in")
    }).pipe(Effect.provide(machine({ spawned, stderr: "Not logged in. Run codex login.\n", exitCode: 1, written })))
  })
})
