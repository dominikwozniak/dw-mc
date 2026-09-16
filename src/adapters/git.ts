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
 * The tool's own bare clone of `repo`, cloned the first time it is asked for.
 *
 * Everything happens in this clone and never in my checkout: a run that reached
 * into the directory I am working in would read whatever I had half finished
 * there.
 *
 * The clone is made once and fetched on every run after that. The fetch brings
 * the branch heads with the pull request's own, because a bare clone is made
 * with no refspec at all: without them the base branch stays at whatever it was
 * the day the clone was made, and a review that diffs against it would report
 * every commit since as the pull request's.
 *
 * The head comes from the pull request's ref rather than from what a sweep last
 * saw, so what is cut is the commit the run really reads.
 */
const cloneAt = Effect.fn("git.cloneAt")(function* (repo: string, number: number) {
  const path = yield* Path.Path
  const state = yield* stateDirectory
  const clone = path.join(state, "repos", `${repo}.git`)

  const bare = yield* Effect.orElseSucceed(git(["-C", clone, "rev-parse", "--is-bare-repository"]), () => "")
  if (bare !== "true") {
    yield* git(["clone", "--bare", "--filter=blob:none", `https://github.com/${repo}.git`, clone])
  }

  const pullRef = `refs/dw-mc/pr/${number}`
  yield* git([
    "-C",
    clone,
    "fetch",
    "--no-tags",
    "--force",
    "origin",
    `+refs/pull/${number}/head:${pullRef}`,
    "+refs/heads/*:refs/heads/*"
  ])
  const head = yield* git(["-C", clone, "rev-parse", pullRef])
  return { clone, head, state }
})

/**
 * Runs `use` in a throwaway worktree at the head of `number`, and takes the
 * worktree down afterwards however the run ended.
 *
 * A worktree left behind would grow the state directory by a copy of the
 * repository per run, and nothing in a review run is worth keeping: what the
 * run found is recorded, and the checkout it read it in is not.
 *
 * The worktree is removed before it is cut as well as after, because the run
 * before this one may have been killed rather than ended.
 */
export const withWorktree = Effect.fn("git.withWorktree")(function* <A, E, R>(
  repo: string,
  number: number,
  use: (worktree: Worktree) => Effect.Effect<A, E, R>
) {
  const path = yield* Path.Path
  const { clone, head, state } = yield* cloneAt(repo, number)
  const directory = path.join(state, "worktrees", repo, String(number))

  // A worktree that is not there cannot be removed, and that is the ordinary
  // case rather than a problem: both ends of the run ask for the same thing.
  const remove = Effect.ignore(git(["-C", clone, "worktree", "remove", "--force", directory]))

  return yield* Effect.acquireUseRelease(
    Effect.flatMap(remove, () => git(["-C", clone, "worktree", "add", "--detach", directory, head])),
    () => use({ directory, head }),
    () => remove
  )
})

/** The worktrees the clone knows it has, by directory. */
const worktreesOf = Effect.fn("git.worktreesOf")(function* (clone: string) {
  const listed = yield* git(["-C", clone, "worktree", "list", "--porcelain"])
  return listed.split("\n").flatMap((line) => (line.startsWith("worktree ") ? [line.slice("worktree ".length)] : []))
})

/**
 * A worktree for a fix session, cut on the pull request's own branch at its
 * head, and left standing when the session ends.
 *
 * It outlives the session because the work in it is mine: I commit and push
 * from inside the session, and a worktree taken down at the end would take an
 * unpushed commit with it. The branch is the pull request's own rather than a
 * detached head, so what I commit has somewhere to go.
 *
 * A previous session's worktree is removed first, and removed without `--force`
 * on purpose: where it still holds changes, `git` refuses in its own words and
 * this stops, which is the whole point. Nothing of mine is thrown away to make
 * room for a fresh cut.
 */
export const fixWorktree = Effect.fn("git.fixWorktree")(function* (repo: string, number: number, branch: string) {
  const path = yield* Path.Path
  const { clone, head, state } = yield* cloneAt(repo, number)
  const directory = path.join(state, "fixes", repo, String(number))

  if ((yield* worktreesOf(clone)).includes(directory)) {
    yield* git(["-C", clone, "worktree", "remove", directory])
  }
  yield* git(["-C", clone, "worktree", "add", "-B", branch, directory, head])

  return { directory, head } satisfies Worktree
})
