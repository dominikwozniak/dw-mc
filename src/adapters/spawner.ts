import { Effect, Layer, PlatformError, Schema, Sink, Stream } from "effect"
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
export const capture = Effect.fn("spawner.capture")(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make(command, args))

  const [stdout, stderr] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
    { concurrency: 2 }
  )
  const exitCode = yield* handle.exitCode

  if (exitCode !== 0) {
    return yield* new CommandFailed({ command, args, exitCode, stderr: stderr.trim() })
  }
  return stdout.trim()
}, Effect.scoped)

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

/** How a spawned command reads as one line, which is how a test names it. */
export const vectorOf = (command: ChildProcess.StandardCommand): string =>
  `${command.command} ${command.args.join(" ")}`

/**
 * One answer a fake spawner has ready, or nothing where the vector is not its
 * business.
 *
 * A stub is handed the command and its argument vector already joined, because
 * almost every stub matches on the second and only a few read the first.
 * Returning nothing rather than an empty success is what lets stubs be stacked:
 * the next one is asked, and a vector none of them claims dies.
 */
export type Stub = (
  command: ChildProcess.StandardCommand,
  argv: string
) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PlatformError.PlatformError> | undefined

/** A program that printed `value` as JSON, which is how `gh --json` answers. */
export const json = (value: unknown): Effect.Effect<ChildProcessSpawner.ChildProcessHandle> =>
  Effect.succeed(fakeHandle({ stdout: JSON.stringify(value) }))

/** A program that wrote `stdout` and exited well. `wrote("")` is one that ran and said nothing. */
export const wrote = (stdout: string): Effect.Effect<ChildProcessSpawner.ChildProcessHandle> =>
  Effect.succeed(fakeHandle({ stdout }))

/** A program that refused, saying `detail` on stderr. */
export const refused = (detail: string, exitCode: number = 1): Effect.Effect<ChildProcessSpawner.ChildProcessHandle> =>
  Effect.succeed(fakeHandle({ exitCode, stderr: detail }))

/**
 * A spawner that answers from `stubs` in order, writes down what it was handed
 * and dies on anything none of them claims.
 *
 * Dying is the point of it. A program no stub thought about is a reach the test
 * did not expect, and an empty success would let it pass as a program that ran
 * and had nothing to say. A piped command dies for the same reason: nothing in
 * the tool builds one, so being handed one means the seam moved.
 */
export const layerStubbed = (options: {
  readonly stubs: ReadonlyArray<Stub>
  /** Where every spawned command is written down, for a test that reads it back. */
  readonly onSpawn?: ((command: ChildProcess.StandardCommand) => void) | undefined
}): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  layerFake((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("spawner: the fake was handed a piped command")
    }
    options.onSpawn?.(command)
    const argv = command.args.join(" ")
    for (const stub of options.stubs) {
      const answer = stub(command, argv)
      if (answer !== undefined) {
        return answer
      }
    }
    return Effect.die(`spawner: nothing stubbed for '${vectorOf(command)}'`)
  })
