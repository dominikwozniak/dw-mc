import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { ChildProcess } from "effect/unstable/process"

import { builtinReview } from "#adapters/runner.ts"
import { fakeHandle, layerFake } from "#adapters/spawner.ts"

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
  layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("runner.test: the fake was handed a piped command")
    }
    options.spawned.push(command)
    return Effect.succeed(
      fakeHandle({ stdout: options.stdout ?? "", stderr: options.stderr, exitCode: options.exitCode })
    )
  })

const nothing = () => Effect.void

describe("the built-in runner", () => {
  it.effect("reviews in the worktree and brings back the report and the session it ran in", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const turn = yield* builtinReview({
        directory: "/home/dw/.local/state/dw-mc/worktrees/dominikwozniak/dw-mc/28",
        effort: "low",
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

  it.effect("keeps every word the runner said, not only its last one", () => {
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
      const turn = yield* builtinReview({ directory: "/worktree", effort: "low", onTool: nothing })

      assert.strictEqual(turn.report, `${report}\n\n${remark}`)
    }).pipe(Effect.provide(claude({ spawned, stdout })))
  })

  it.effect("falls back to the last word when the runner said nothing before it", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const stdout = JSON.stringify(success)

    return Effect.gen(function* () {
      const turn = yield* builtinReview({ directory: "/worktree", effort: "low", onTool: nothing })

      assert.strictEqual(turn.report, report)
    }).pipe(Effect.provide(claude({ spawned, stdout })))
  })

  it.effect("never passes --comment, because the built-in review comments only when it is", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      yield* builtinReview({ directory: "/worktree", effort: "high", onTool: nothing })

      assert.isFalse(spawned.some((command) => command.args.includes("--comment")))
    }).pipe(Effect.provide(claude({ spawned, stdout: transcript(success) })))
  })

  it.effect("spends what the effort says", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      yield* builtinReview({ directory: "/worktree", effort: "high", onTool: nothing })

      assert.include(spawned[0]?.args ?? [], "/code-review high")
    }).pipe(Effect.provide(claude({ spawned, stdout: transcript(success) })))
  })

  it.effect("says what the run is doing while it is still doing it", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const tools: Array<string> = []

    return Effect.gen(function* () {
      yield* builtinReview({
        directory: "/worktree",
        effort: "low",
        onTool: (tool) => Effect.sync(() => tools.push(tool))
      })

      assert.deepStrictEqual(tools, ["Bash", "Agent"])
    }).pipe(Effect.provide(claude({ spawned, stdout: transcript(success) })))
  })

  it.effect("a runner that exits non-zero is a failure, not an empty report", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(builtinReview({ directory: "/worktree", effort: "low", onTool: nothing }))

      assert.strictEqual(error._tag, "RunnerFailed")
      assert.include(error.message, "Invalid API key")
    }).pipe(Effect.provide(claude({ spawned, stderr: "Invalid API key · Run /login\n", exitCode: 1 })))
  })

  it.effect("a run that ends without a result is a failure", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []

    return Effect.gen(function* () {
      const error = yield* Effect.flip(builtinReview({ directory: "/worktree", effort: "low", onTool: nothing }))

      assert.strictEqual(error._tag, "RunnerFailed")
      assert.include(error.message, "no result")
    }).pipe(Effect.provide(claude({ spawned, stdout: `{"type":"system","subtype":"init"}\n` })))
  })

  it.effect("a run the runner itself calls an error is a failure", () => {
    const spawned: Array<ChildProcess.StandardCommand> = []
    const gaveUp = { ...success, subtype: "error_max_turns", is_error: true, result: "Reached max turns" }

    return Effect.gen(function* () {
      const error = yield* Effect.flip(builtinReview({ directory: "/worktree", effort: "low", onTool: nothing }))

      assert.strictEqual(error._tag, "RunnerFailed")
      assert.include(error.message, "error_max_turns")
    }).pipe(Effect.provide(claude({ spawned, stdout: transcript(gaveUp) })))
  })
})
