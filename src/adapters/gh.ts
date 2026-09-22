import { Effect, PlatformError, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"

import { capture } from "#adapters/spawner.ts"
import type { CommandFailed } from "#adapters/spawner.ts"

/**
 * The boundary every call to GitHub crosses: whether `gh` runs and as whom, the
 * repository it stands in, and one call decoded with its failures in our words.
 * The calls themselves live beside it, by what they read or write.
 */

/** `gh` is on the machine but would not run. */
export class GhUnavailable extends Schema.TaggedError<GhUnavailable>()("GhUnavailable", {
  detail: Schema.String
}) {
  override get message(): string {
    return `gh could not be run: ${this.detail}\nInstall it from https://cli.github.com, then run 'gh auth login'.`
  }
}

/** `gh` runs but is not logged in, so every read of GitHub would fail. */
export class GhUnauthenticated extends Schema.TaggedError<GhUnauthenticated>()("GhUnauthenticated", {
  detail: Schema.String
}) {
  override get message(): string {
    return `gh is not authenticated. Run 'gh auth login'.\n${this.detail}`
  }
}

/** The working directory is not inside a repository `gh` can name. */
export class NoRepository extends Schema.TaggedError<NoRepository>()("NoRepository", {
  detail: Schema.String
}) {
  override get message(): string {
    return `This directory is not a GitHub repository dw-mc can register.\n${this.detail}`
  }
}

/** `gh` answered, in a shape this version of dw-mc does not know. */
export class GhUnreadable extends Schema.TaggedError<GhUnreadable>()("GhUnreadable", {
  command: Schema.String,
  reason: Schema.String
}) {
  override get message(): string {
    return `gh ${this.command} answered with something dw-mc cannot read: ${this.reason}`
  }
}

/** What a `gh` that would not even start comes to. */
const unavailable = (error: PlatformError.PlatformError): GhUnavailable =>
  new GhUnavailable({ detail: error.reason._tag === "NotFound" ? "it is not installed" : error.message })

/**
 * Stops unless `gh` is installed and logged in.
 *
 * Every read of GitHub goes through `gh` as me, so a missing or logged-out `gh`
 * is worth saying once, up front, rather than as an empty table later.
 */
export const requireAuth: Effect.Effect<
  void,
  GhUnavailable | GhUnauthenticated,
  ChildProcessSpawner.ChildProcessSpawner
> = capture("gh", ["auth", "status"]).pipe(
  Effect.asVoid,
  Effect.catchTags({
    PlatformError: (error) => Effect.fail(unavailable(error)),
    CommandFailed: (error) => Effect.fail(new GhUnauthenticated({ detail: error.stderr }))
  }),
  Effect.withSpan("gh.requireAuth")
)

const RepoView = Schema.fromJsonString(Schema.Struct({ nameWithOwner: Schema.String }))

/** The `owner/repo` of the repository the working directory is in. */
export const currentRepo: Effect.Effect<
  string,
  GhUnavailable | NoRepository | GhUnreadable,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const json = yield* capture("gh", ["repo", "view", "--json", "nameWithOwner"]).pipe(
    Effect.catchTags({
      PlatformError: (error) => Effect.fail(unavailable(error)),
      CommandFailed: (error) => Effect.fail(new NoRepository({ detail: error.stderr }))
    })
  )

  const view = yield* Schema.decodeEffect(RepoView)(json).pipe(
    Effect.mapError((error) => new GhUnreadable({ command: "repo view", reason: error.message }))
  )
  return view.nameWithOwner
}).pipe(Effect.withSpan("gh.currentRepo"))

/** A call to GitHub that `gh` itself refused, whether it was reading or writing. */
export class GhReadFailed extends Schema.TaggedError<GhReadFailed>()("GhReadFailed", {
  command: Schema.String,
  detail: Schema.String
}) {
  override get message(): string {
    return `gh ${this.command} failed: ${this.detail}`
  }
}

/** A failed `gh` call: `GhUnavailable` if it would not start, `GhReadFailed` under `command` if it refused. */
export const failedAs =
  (command: string) =>
  <A, R>(
    call: Effect.Effect<A, PlatformError.PlatformError | CommandFailed, R>
  ): Effect.Effect<A, GhUnavailable | GhReadFailed, R> =>
    Effect.catchTags(call, {
      PlatformError: (error) => Effect.fail(unavailable(error)),
      CommandFailed: (error) => Effect.fail(new GhReadFailed({ command, detail: error.stderr }))
    })

/** Anything that can go wrong reading GitHub through `gh`. */
export type GhError = GhUnavailable | GhReadFailed | GhUnreadable

/** One `gh` read, decoded, with every way it can go wrong in our words. */
export const readJson = <A>(
  label: string,
  command: string,
  args: ReadonlyArray<string>,
  schema: Schema.Codec<A, string>
): Effect.Effect<A, GhError, ChildProcessSpawner.ChildProcessSpawner> =>
  capture(command, args).pipe(
    failedAs(label),
    Effect.flatMap((json) =>
      Schema.decodeEffect(schema)(json).pipe(
        Effect.mapError((error) => new GhUnreadable({ command: label, reason: error.message }))
      )
    ),
    Effect.withSpan(`gh.${label}`)
  )

const User = Schema.fromJsonString(Schema.Struct({ login: Schema.String }))

/** The login `gh` is authenticated as: the "me" every read is scoped to. */
export const viewer: Effect.Effect<string, GhError, ChildProcessSpawner.ChildProcessSpawner> = readJson(
  "api user",
  "gh",
  ["api", "user"],
  User
).pipe(Effect.map((user) => user.login))
