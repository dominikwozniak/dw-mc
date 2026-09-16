import { Effect, Layer, Schema, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const encoder = new TextEncoder()

/** A program that ran but ended badly. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  args: Schema.Array(Schema.String),
  exitCode: Schema.Int,
  stderr: Schema.String
}) {
  override get message(): string {
    return `${[this.command, ...this.args].join(" ")} exited ${this.exitCode}: ${this.stderr}`
  }
}

/**
 * Runs a program to completion and returns its trimmed standard output.
 *
 * The spawner's own `string` collects stdout without ever reading the exit
 * code, so a program that failed would come back as an empty success. This
 * reads both, and a non-zero exit is a failure carrying whatever the program
 * said on stderr. The two output streams drain together, because draining one
 * to the end first can block a program that is still writing to the other.
 */
export const capture = Effect.fn("spawner.capture")(
  function*(command: string, args: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(command, args))

    const [stdout, stderr] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr))
      ],
      { concurrency: 2 }
    )
    const exitCode = yield* handle.exitCode

    if (exitCode !== 0) {
      return yield* new CommandFailed({ command, args, exitCode, stderr: stderr.trim() })
    }
    return stdout.trim()
  },
  Effect.scoped
)

/**
 * A `ChildProcessSpawner` built from a fake spawn function, for tests.
 *
 * `ChildProcessSpawner.make` derives `string`, `lines`, `exitCode` and the
 * streams from the spawn function alone, which is how the Node spawner is built
 * too, so one fake spawn gives the whole service.
 */
export const layerFake = (
  spawn: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"]
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn))

/**
 * A finished process for a fake spawn function to return.
 *
 * `ChildProcessHandle` carries a private brand, so an object literal cannot
 * stand in for one.
 */
export const fakeHandle = (options: {
  readonly stdout?: string | undefined
  readonly stderr?: string | undefined
  readonly exitCode?: number | undefined
  readonly pid?: number | undefined
}): ChildProcessSpawner.ChildProcessHandle => {
  const stdout = Stream.succeed(encoder.encode(options.stdout ?? ""))
  const stderr = Stream.succeed(encoder.encode(options.stderr ?? ""))
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(options.pid ?? 1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout,
    stderr,
    all: Stream.merge(stdout, stderr),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void)
  })
}
