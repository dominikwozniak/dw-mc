import { Effect, Path, Schema } from "effect"

import { capture } from "#adapters/spawner.ts"
import { stateDirectory } from "#adapters/store.ts"

/** A `git` command that ran and refused, or would not run at all. */
export class GitFailed extends Schema.TaggedError<GitFailed>()("GitFailed", {
  args: Schema.Array(Schema.String),
  detail: Schema.String
}) {
  override get message(): string {
    return `git ${this.args.join(" ")} failed: ${this.detail}`
  }
}

/** One `git` command, with both ways it can go wrong in our words. */
const git = (args: ReadonlyArray<string>) =>
  capture("git", args).pipe(
    Effect.catchTags({
      PlatformError: (error) => Effect.fail(new GitFailed({ args, detail: error.message })),
      CommandFailed: (error) => Effect.fail(new GitFailed({ args, detail: error.stderr }))
    })
  )

/** A checkout cut for one run, and the commit it stands on. */
export interface Worktree {
  readonly directory: string
  readonly head: string
}

/**
 * Runs `use` in a throwaway worktree at the head of `number`, and takes the
 * worktree down afterwards however the run ended.
 *
 * Everything happens in the tool's own bare clone under the state directory, so
 * my checkout is neither read nor written while a run is going: a review that
 * reached into the directory I am working in would review whatever I had half
 * finished there, and a run that left a worktree behind would grow the state
 * directory by a copy of the repository per run.
 *
 * The clone is made once and fetched on every run after that. The head comes
 * from the pull request's own ref rather than from what a sweep last saw, so
 * what the run is recorded against is the commit it actually read. The worktree
 * is removed before it is cut as well as after, because the run before this one
 * may have been killed rather than ended.
 */
export const withWorktree = Effect.fnUntraced(function* <A, E, R>(
  repo: string,
  number: number,
  use: (worktree: Worktree) => Effect.Effect<A, E, R>
) {
  const path = yield* Path.Path
  const state = yield* stateDirectory
  const clone = path.join(state, "repos", `${repo}.git`)
  const directory = path.join(state, "worktrees", repo, String(number))

  const bare = yield* Effect.orElseSucceed(git(["-C", clone, "rev-parse", "--is-bare-repository"]), () => "")
  if (bare !== "true") {
    yield* git(["clone", "--bare", "--filter=blob:none", `https://github.com/${repo}.git`, clone])
  }

  yield* git(["-C", clone, "fetch", "--no-tags", "--force", "origin", `refs/pull/${number}/head`])
  const head = yield* git(["-C", clone, "rev-parse", "FETCH_HEAD"])

  // A worktree that is not there cannot be removed, and that is the ordinary
  // case rather than a problem: both ends of the run ask for the same thing.
  const remove = Effect.ignore(git(["-C", clone, "worktree", "remove", "--force", directory]))

  return yield* Effect.acquireUseRelease(
    Effect.flatMap(remove, () => git(["-C", clone, "worktree", "add", "--detach", directory, head])),
    () => use({ directory, head }),
    () => remove
  )
})
