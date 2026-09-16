import { assert, describe, it } from "@effect/vitest"
import { Effect, PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { capture, fakeHandle, layerFake } from "./spawner.ts"

describe("spawner", () => {
  it.effect("capture hands the argv to the spawner and trims its stdout", () => {
    const spawned: Array<ReadonlyArray<string>> = []
    const gh = layerFake((command) => {
      if (command._tag !== "StandardCommand") {
        return Effect.die("spawner.test: the fake was handed a piped command")
      }
      spawned.push([command.command, ...command.args])
      return Effect.succeed(fakeHandle({ stdout: "gh version 0.0.0-fake\n" }))
    })

    return Effect.gen(function*() {
      const version = yield* capture("gh", ["--version"])

      assert.strictEqual(version, "gh version 0.0.0-fake")
      assert.deepStrictEqual(spawned, [["gh", "--version"]])
    }).pipe(Effect.provide(gh))
  })

  it.effect("a program that will not start reaches the caller as a PlatformError", () => {
    const missing = layerFake(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "spawner.test: no such program"
        })
      )
    )

    return Effect.gen(function*() {
      const error = yield* Effect.flip(capture("nope", []))

      assert.strictEqual(error._tag, "PlatformError")
      assert.strictEqual(error.reason._tag, "NotFound")
    }).pipe(Effect.provide(missing))
  })

  it.effect("the fake's combined output carries stderr as well as stdout", () => {
    const noisy = layerFake(() => Effect.succeed(fakeHandle({ stdout: "out", stderr: "err" })))

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const both = yield* spawner.string(ChildProcess.make("noisy", []), { includeStderr: true })

      assert.isTrue(both.includes("out"))
      assert.isTrue(both.includes("err"))
    }).pipe(Effect.provide(noisy))
  })
})
