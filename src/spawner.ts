import { Effect, Layer, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const encoder = new TextEncoder()

/**
 * Runs a program to completion and returns its trimmed standard output.
 *
 * The one place the tool builds a `ChildProcess`, so `gh`, `claude` and `codex`
 * do not each re-derive collecting stdout and trimming the trailing newline.
 */
export const capture = Effect.fn("spawner.capture")(function*(
  command: string,
  args: ReadonlyArray<string>
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const output = yield* spawner.string(ChildProcess.make(command, args))
  return output.trim()
})

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
