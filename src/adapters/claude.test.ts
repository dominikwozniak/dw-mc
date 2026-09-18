import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, PlatformError, Result } from "effect"
import { TestClock } from "effect/testing"
import type { ChildProcess } from "effect/unstable/process"

import { commandReview, findingsTurn, promptReview, reviewTurns, steeredSession } from "#adapters/claude.ts"
import type { Launcher } from "#adapters/config.ts"
import { builtInLauncher } from "#adapters/config.ts"
import { fakeHandle, layerFake, layerStubbed, wrote } from "#adapters/spawner.ts"

const launcher = builtInLauncher
const session = "befb6186-5471-4b26-b680-e8ca49df25ac"
const report = "## Standards\n\n1. The write boundary fails open on an unreadable flag."

/** The events `claude --output-format stream-json` really emits, in the order it emits them. */
const transcript = (result: Record<string, unknown>) =>
  [
    { type: "system", subtype: "init", session_id: session, model: "claude-opus-5" },
    { type: "system", subtype: "thinking_tokens" },
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "" },
          { type: "tool_use", name: "Bash" }
        ]
      }
    },
    { type: "rate_limit_event" },
    { type: "user", message: { content: [{ type: "tool_result", content: "4 commits" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Agent" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: report }] } },
    result
  ]
    .map((event) => JSON.stringify(event))
    .join("\n")

const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: report,
  session_id: session,
  num_turns: 7
}

/** A `claude` that prints `stdout` and records how it was spawned. */
const claude = (options: {
  readonly spawned: Array<ChildProcess.StandardCommand>
  readonly stdout?: string | undefined
  readonly stderr?: string | undefined
  readonly exitCode?: number | undefined
}) =>
  layerStubbed({
    onSpawn: (command) => options.spawned.push(command),
    stubs: [
      () =>
        Effect.succeed(fakeHandle({ stdout: options.stdout ?? "", stderr: options.stderr, exitCode: options.exitCode }))
    ]
  })

const nothing = () => Effect.void

describe("a review run on a slash command", () => {
  it.effect("reviews in the worktree and brings back the report and the session it ran in", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const turn = yield* commandReview({
        launcher,
        directory: "/home/dw/.local/state/dw-mc/worktrees/dominikwozniak/dw-mc/28",
        line: "/code-review low",
        instructions: null,
        model: null,
        onTool: nothing
      })

      assert.deepStrictEqual(turn, { report, sessionId: session })
      assert.deepStrictEqual(
        spawned.map((command) => [command.command, ...command.args]),
        [["claude", "-p", "/code-review low", "--output-format", "stream-json", "--verbose"]]
      )
      assert.strictEqual(spawned[0]?.options.cwd, "/home/dw/.local/state/dw-mc/worktrees/dominikwozniak/dw-mc/28")
    }).pipe(Effect.provide(claude({ spawned, stdout: transcript(success) })))
  })

  it.effect("keeps every word the run said, not only its last one", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    // What a repository whose review command fans out to subagents really ends
    // on: the report, then a remark about the notification that followed it.
    const remark = "That's the completion notification for the Spec agent. Nothing further to add."
    const stdout = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: report }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: remark }] } }),
      JSON.stringify({ ...success, result: remark })
    ].join("\n")

    return Effect.gen(function* () {
      const turn = yield* commandReview({
        launcher,
        directory: "/worktree",
        line: "/code-review low",
        instructions: null,
        model: null,
        onTool: nothing
      })

      assert.strictEqual(turn.report, `${report}\n\n${remark}`)
    }).pipe(Effect.provide(claude({ spawned, stdout })))
  })

  it.effect("falls back to the last word when the run said nothing before it", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const stdout = JSON.stringify(success)

    return Effect.gen(function* () {
      const turn = yield* commandReview({
        launcher,
        directory: "/worktree",
        line: "/code-review low",
        instructions: null,
        model: null,
        onTool: nothing
      })

      assert.strictEqual(turn.report, report)
    }).pipe(Effect.provide(claude({ spawned, stdout })))
  })

  it.effect("never passes --comment, because the built-in review comments only when it is", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      yield* commandReview({
        launcher,
        directory: "/worktree",
        line: "/code-review high",
        instructions: null,
        model: null,
        onTool: nothing
      })

      assert.isFalse(spawned.some((command) => command.args.includes("--comment")))
    }).pipe(Effect.provide(claude({ spawned, stdout: transcript(success) })))
  })

  it.effect("opens on the line it was given", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      yield* commandReview({
        launcher,
        directory: "/worktree",
        line: "/code-review high",
        instructions: null,
        model: null,
        onTool: nothing
      })

      assert.include(spawned[0]?.args ?? [], "/code-review high")
    }).pipe(Effect.provide(claude({ spawned, stdout: transcript(success) })))
  })

  it.effect("says what the run is doing while it is still doing it", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const tools: Array<string> = []

    return Effect.gen(function* () {
      yield* commandReview({
        launcher,
        directory: "/worktree",
        line: "/code-review low",
        instructions: null,
        model: null,
        onTool: (tool) => Effect.sync(() => tools.push(tool))
      })

      assert.deepStrictEqual(tools, ["Bash", "Agent"])
    }).pipe(Effect.provide(claude({ spawned, stdout: transcript(success) })))
  })

  it.effect("a run that exits non-zero is a failure, not an empty report", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        commandReview({
          launcher,
          directory: "/worktree",
          line: "/code-review low",
          instructions: null,
          model: null,
          onTool: nothing
        })
      )

      assert.strictEqual(error._tag, "AgentFailed")
      assert.include(error.message, "Invalid API key")
    }).pipe(Effect.provide(claude({ spawned, stderr: "Invalid API key · Run /login\n", exitCode: 1 })))
  })

  it.effect("a run that ends without a result is a failure", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        commandReview({
          launcher,
          directory: "/worktree",
          line: "/code-review low",
          instructions: null,
          model: null,
          onTool: nothing
        })
      )

      assert.strictEqual(error._tag, "AgentFailed")
      assert.include(error.message, "no result")
    }).pipe(Effect.provide(claude({ spawned, stdout: `{"type":"system","subtype":"init"}\n` })))
  })

  it.effect("a run Claude Code itself calls an error is a failure", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const gaveUp = { ...success, subtype: "error_max_turns", is_error: true, result: "Reached max turns" }

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        commandReview({
          launcher,
          directory: "/worktree",
          line: "/code-review low",
          instructions: null,
          model: null,
          onTool: nothing
        })
      )

      assert.strictEqual(error._tag, "AgentFailed")
      assert.include(error.message, "error_max_turns")
    }).pipe(Effect.provide(claude({ spawned, stdout: transcript(gaveUp) })))
  })
})

describe("the findings turn", () => {
  const schema = `{"type":"object","properties":{"verdict":{"type":"string"}}}`
  const found = {
    verdict: "findings",
    findings: [{ file: "src/cli/review.ts", line: 88, severity: "error", summary: "The run is never recorded." }]
  }

  /** What `claude --output-format json --json-schema` really prints: one result object. */
  const answer = (fields: Record<string, unknown>) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: session,
      result: JSON.stringify(found),
      num_turns: 2,
      ...fields
    })

  const reporting = (spawned: Array<ChildProcess.StandardCommand>) =>
    findingsTurn({ launcher, directory: "/worktree", sessionId: session, jsonSchema: schema }).pipe(
      Effect.provide(claude({ spawned, stdout: answer({ structured_output: found }) }))
    )

  it.effect("resumes the first turn's session and brings back what the run validated", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const output = yield* reporting(spawned)

      assert.deepStrictEqual(output, found)
      assert.deepStrictEqual(spawned[0]?.args.slice(0, 3), ["-p", "--resume", session])
      assert.deepStrictEqual(spawned[0]?.args.slice(-4), ["--output-format", "json", "--json-schema", schema])
    })
  })

  it.effect("asks for the findings of the review it just gave", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      yield* reporting(spawned)

      assert.include(spawned[0]?.args[3] ?? "", "structured output")
    })
  })

  it.effect("reports in the worktree the review ran in", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      yield* reporting(spawned)

      assert.strictEqual(spawned[0]?.options.cwd, "/worktree")
    })
  })

  it.effect("a turn that exits non-zero is a failure", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        findingsTurn({ launcher, directory: "/worktree", sessionId: session, jsonSchema: schema })
      )

      assert.strictEqual(error._tag, "AgentFailed")
      assert.include(error.message, "No conversation found")
    }).pipe(Effect.provide(claude({ spawned, stderr: "No conversation found\n", exitCode: 1 })))
  })

  it.effect("a turn that validated nothing is a failure, never a clean verdict", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        findingsTurn({ launcher, directory: "/worktree", sessionId: session, jsonSchema: schema })
      )

      assert.strictEqual(error._tag, "AgentFailed")
      assert.include(error.message, "no structured output")
    }).pipe(Effect.provide(claude({ spawned, stdout: answer({}) })))
  })

  it.effect("a turn that answered with something this cannot read is a failure", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        findingsTurn({ launcher, directory: "/worktree", sessionId: session, jsonSchema: schema })
      )

      assert.strictEqual(error._tag, "AgentFailed")
      assert.include(error.message, "no result")
    }).pipe(Effect.provide(claude({ spawned, stdout: "Command completed" })))
  })

  it.effect("a turn the runner itself calls an error is a failure", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        findingsTurn({ launcher, directory: "/worktree", sessionId: session, jsonSchema: schema })
      )

      assert.strictEqual(error._tag, "AgentFailed")
      assert.include(error.message, "error_during_execution")
    }).pipe(
      Effect.provide(
        claude({ spawned, stdout: answer({ subtype: "error_during_execution", is_error: true, result: "gave up" }) })
      )
    )
  })

  it.effect("a turn that never comes back is a failure rather than a command that hangs", () =>
    Effect.gen(function* () {
      const turn = yield* Effect.forkChild(
        Effect.flip(findingsTurn({ launcher, directory: "/worktree", sessionId: session, jsonSchema: schema }))
      )

      yield* TestClock.adjust(Duration.minutes(6))

      const error = yield* Fiber.join(turn)
      assert.strictEqual(error._tag, "AgentFailed")
      assert.include(error.message, "did not come back")
    }).pipe(Effect.provide(layerFake(() => Effect.never)))
  )
})

describe("the prompt runner on Claude Code", () => {
  const schema = `{"type":"object","properties":{"verdict":{"type":"string"}}}`
  const prompt = "You are an experienced staff engineer conducting a thorough code review."
  const found = {
    verdict: "findings",
    findings: [{ file: "src/cli/review.ts", line: 88, severity: "error", summary: "The run is never recorded." }]
  }

  /** What one stream-json turn given a schema really prints: prose, then a result carrying both. */
  const answered = (result: Record<string, unknown>) =>
    [
      { type: "assistant", message: { content: [{ type: "text", text: report }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } },
      { ...success, structured_output: found, result: JSON.stringify(found), ...result }
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")

  it.effect("reviews on the tool's own prompt and brings back what one turn validated", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const reported = yield* promptReview({
        launcher,
        directory: "/worktree",
        prompt,
        model: null,
        jsonSchema: schema,
        onTool: nothing
      })

      assert.deepStrictEqual(reported, { findings: found, sessionId: session, prose: report })
      assert.deepStrictEqual(
        spawned.map((command) => [command.command, ...command.args]),
        [["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--json-schema", schema]]
      )
      assert.strictEqual(spawned[0]?.options.cwd, "/worktree")
    }).pipe(Effect.provide(claude({ spawned, stdout: answered({}) })))
  })

  it.effect("runs the prompt on the model the repository configured", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      yield* promptReview({
        launcher,
        directory: "/worktree",
        prompt,
        model: "claude-opus-5",
        jsonSchema: schema,
        onTool: nothing
      })

      assert.deepStrictEqual(spawned[0]?.args.slice(-2), ["--model", "claude-opus-5"])
    }).pipe(Effect.provide(claude({ spawned, stdout: answered({}) })))
  })

  it.effect("says what the run is reaching for while it is still running", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const tools: Array<string> = []

    return Effect.gen(function* () {
      yield* promptReview({
        launcher,
        directory: "/worktree",
        prompt,
        model: null,
        jsonSchema: schema,
        onTool: (tool) => Effect.sync(() => tools.push(tool))
      })

      assert.deepStrictEqual(tools, ["Read"])
    }).pipe(Effect.provide(claude({ spawned, stdout: answered({}) })))
  })

  it.effect("a run that validated nothing is a failure, never a clean verdict", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        promptReview({ launcher, directory: "/worktree", prompt, model: null, jsonSchema: schema, onTool: nothing })
      )

      assert.strictEqual(error._tag, "AgentFailed")
      assert.include(error.message, "no structured output")
    }).pipe(Effect.provide(claude({ spawned, stdout: JSON.stringify(success) })))
  })
})

describe("one review run, in whichever shape it was configured in", () => {
  const schema = `{"type":"object","properties":{"verdict":{"type":"string"}}}`
  const found = {
    verdict: "findings",
    findings: [{ file: "src/cli/review.ts", line: 88, severity: "error", summary: "The run is never recorded." }]
  }

  /** A `claude` that answers the review turn and the findings turn differently. */
  const turns = (spawned: Array<ChildProcess.StandardCommand>, reporting?: Record<string, unknown>) =>
    layerStubbed({
      onSpawn: (command) => spawned.push(command),
      stubs: [
        (command) =>
          wrote(
            command.args.includes("--resume")
              ? JSON.stringify({ ...success, session_id: session, structured_output: found, ...reporting })
              : [
                  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: report }] } }),
                  JSON.stringify({ ...success, structured_output: found })
                ].join("\n")
          )
      ]
    })

  const running = (turn: Parameters<typeof reviewTurns>[0]["turn"]) =>
    reviewTurns({ launcher, directory: "/worktree", turn, model: null, jsonSchema: schema, onTool: nothing })

  it.effect("takes one turn on the tool's own prompt, with the schema beside it", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const run = yield* running({ _tag: "prompt", text: "Review the change." })

      assert.strictEqual(run.sessionId, session)
      assert.deepStrictEqual(run.findings, Result.succeed(found))
      assert.lengthOf(spawned, 1)
      assert.include(spawned[0]?.args ?? [], "--json-schema")
    }).pipe(Effect.provide(turns(spawned)))
  })

  it.effect("takes two turns on a slash command, and never hands the first one a schema", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const run = yield* running({ _tag: "command", line: "/code-review low", instructions: null })

      assert.strictEqual(run.prose, report)
      assert.deepStrictEqual(run.findings, Result.succeed(found))
      assert.lengthOf(spawned, 2)
      assert.isFalse(spawned[0]?.args.includes("--json-schema"))
      assert.include(spawned[1]?.args ?? [], "--resume")
      assert.include(spawned[1]?.args ?? [], "--json-schema")
    }).pipe(Effect.provide(turns(spawned)))
  })

  it.effect("carries my own instructions beside the slash command, not inside its arguments", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      yield* running({ _tag: "command", line: "/code-review low", instructions: "Look at the N+1 queries." })

      assert.deepStrictEqual(spawned[0]?.args.slice(0, 2), ["-p", "/code-review low"])
      assert.deepStrictEqual(spawned[0]?.args.slice(-2), ["--append-system-prompt", "Look at the N+1 queries."])
    }).pipe(Effect.provide(turns(spawned)))
  })

  it.effect("keeps the review where the findings turn could not report", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const run = yield* running({ _tag: "command", line: "/code-review low", instructions: null })

      assert.strictEqual(run.prose, report)
      assert.strictEqual(run.sessionId, session)
      assert.isTrue(Result.isFailure(run.findings))
    }).pipe(Effect.provide(turns(spawned, { structured_output: undefined })))
  })
})

describe("steeredSession", () => {
  it.effect("opens claude in the worktree, on the prompt, with my terminal handed to it", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const ended = yield* steeredSession({ launcher, directory: "/fixes/28", prompt: "Work through these findings" })

      assert.strictEqual(ended, 0)
      const [command] = spawned
      assert.strictEqual(command?.command, "claude")
      assert.deepStrictEqual(command?.args, ["Work through these findings"])
      assert.strictEqual(command?.options.cwd, "/fixes/28")
      assert.deepStrictEqual(
        [command?.options.stdin, command?.options.stdout, command?.options.stderr],
        ["inherit", "inherit", "inherit"]
      )
      // A detached child sits outside the terminal's foreground process group,
      // where nothing I type reaches it.
      assert.strictEqual(command?.options.detached, false)
    }).pipe(Effect.provide(claude({ spawned })))
  })

  it.effect("starts what the launcher names, its own arguments first and the prompt last", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const wrapper: Launcher = { command: ["cswap", "run", "--"], fix_args: ["--enable-auto-mode"] }

    return Effect.gen(function* () {
      yield* steeredSession({ launcher: wrapper, directory: "/fixes/28", prompt: "Work through these findings" })

      const [command] = spawned
      assert.strictEqual(command?.command, "cswap")
      assert.deepStrictEqual(command?.args, ["run", "--", "--enable-auto-mode", "Work through these findings"])
    }).pipe(Effect.provide(claude({ spawned })))
  })

  it.effect("hands back the code the session ended on rather than reading anything it printed", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      assert.strictEqual(yield* steeredSession({ launcher, directory: "/fixes/28", prompt: "Work through these" }), 130)
    }).pipe(Effect.provide(claude({ spawned, exitCode: 130 })))
  })

  it.effect("a claude that will not start is a failure in our words", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        steeredSession({ launcher, directory: "/fixes/28", prompt: "Work through these" })
      )

      assert.strictEqual(error._tag, "AgentFailed")
      assert.include(error.message, "no claude on this machine")
    }).pipe(
      Effect.provide(
        layerStubbed({
          stubs: [
            () =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "ChildProcess",
                  method: "spawn",
                  description: "no claude on this machine"
                })
              )
          ]
        })
      )
    )
  )
})
