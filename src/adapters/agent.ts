/**
 * How one turn of Claude Code is spawned and given up on, and what a turn that
 * answers against a schema comes back with.
 *
 * Every turn is reached this way, so the spawn, the patience and the one failure
 * they can end in live here rather than once per turn.
 */
import { Duration, Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

/** A review run that would not start, would not finish, or finished badly. */
export class AgentFailed extends Schema.TaggedError<AgentFailed>()("AgentFailed", {
  /** The program that was spawned, which is what a search for it has to name. */
  program: Schema.String,
  detail: Schema.String
}) {
  override get message(): string {
    return `The ${this.program} review run failed: ${this.detail}`
  }
}

/** What a review turn held to a schema came back with. */
export interface Reported {
  /** What the run validated against the schema, handed on unread. */
  readonly findings: unknown
  /** The session the run happened in, which is what a run is recorded against. */
  readonly sessionId: string
  /** What the run said in prose beside its findings, or null where it said none. */
  readonly prose: string | null
}

/**
 * Failures in the name of the program that was spawned.
 *
 * Where the launcher starts `claude` through another program, it is that
 * program that would not start or exited badly, and saying `claude` sends the
 * search to the wrong process.
 */
export const failedBy = (program: string) => (detail: string) => new AgentFailed({ program, detail })

/**
 * How long each turn gets before it is given up on.
 *
 * The review is the turn that thinks, and a high-effort one that fans out to
 * subagents takes real minutes, so its limit is there to catch a run that has
 * stopped rather than one that is slow. The second turn reads no code and
 * decides nothing - the review it reports on is already in the session it
 * resumes - and every run of it by hand came back in seconds.
 *
 * Either way, a command that hangs forever is worse than one that says it
 * failed: a review I walked away from is one I need to be able to come back to.
 */
export const patience = {
  reviewing: Duration.minutes(45),
  reporting: Duration.minutes(5)
}

/**
 * One turn of the launcher in `directory`, with `read` over its standard output.
 *
 * The launcher's own arguments go in front of the turn's, because they are what
 * gets `claude` started at all. The two output streams are drained together,
 * because draining one to the end first can block a run that is still writing to
 * the other. Every way a turn can fail to finish comes back from here as a
 * `AgentFailed`, so a caller is left with the turn's own answer and nothing else
 * to translate - a turn that never comes back included.
 */
export const turn = Effect.fnUntraced(function* <A, E extends { readonly message: string }, R>(options: {
  /** The program and the prefix that starts Claude Code. */
  readonly command: readonly [string, ...Array<string>]
  readonly directory: string
  readonly args: ReadonlyArray<string>
  /** What this turn is called when it is late, and how long it has. */
  readonly patience: { readonly turn: string; readonly duration: Duration.Duration }
  readonly read: (stdout: ChildProcessSpawner.ChildProcessHandle["stdout"]) => Effect.Effect<A, E, R>
}) {
  const [program, ...prefix] = options.command
  const failed = failedBy(program)
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const running = Effect.gen(function* () {
    const handle = yield* Effect.mapError(
      spawner.spawn(
        ChildProcess.make(program, [...prefix, ...options.args], { cwd: options.directory, stdin: "pipe" })
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
