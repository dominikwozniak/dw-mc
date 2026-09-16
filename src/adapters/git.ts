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

/** A fix worktree that still holds work of mine, which nothing may cut away. */
export class WorktreeHeld extends Schema.TaggedError<WorktreeHeld>()("WorktreeHeld", {
  directory: Schema.String,
  detail: Schema.String
}) {
  override get message(): string {
    return `${this.detail}\nThe worktree is at ${this.directory}.`
  }
}

/**
 * Where a worktree is cut from, what it is cut at, and where it goes: the tool's
 * own bare clone of `repo`, the pull request's head, and a directory under
 * `under` in the state directory.
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
const whereToCut = Effect.fn("git.whereToCut")(function* (repo: string, number: number, under: string) {
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
  return { clone, head, directory: path.join(state, under, repo, String(number)) }
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
  const { clone, directory, head } = yield* whereToCut(repo, number, "worktrees")

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

/** How far the branch a fix worktree stands on has gone past `head`. */
const aheadOf = Effect.fn("git.aheadOf")(function* (clone: string, branch: string, head: string) {
  const counted = yield* git(["-C", clone, "rev-list", "--count", branch, `^${head}`])
  return Number(counted.trim())
})

/**
 * A worktree for a fix session, on a branch of the tool's own, and left
 * standing when the session ends.
 *
 * It outlives the session because the work in it is mine: I commit and push
 * from inside the session, and a worktree taken down at the end would take an
 * unpushed commit with it.
 *
 * The branch is `dw-mc/fix/<number>` and never the pull request's own, which is
 * verified rather than a preference: `git` refuses to fetch into a branch that
 * a worktree has checked out, so a worktree standing on the pull request's
 * branch would fail the next fetch of this clone and take every command that
 * reads it down with it. The branch tracks the pull request's, so a plain
 * `git push` from inside the session lands on the pull request.
 *
 * A previous session's worktree is cut away first, and only where there is
 * nothing of mine in it: `git worktree remove` without `--force` refuses over
 * changes I have not committed, and a branch that has gone past the head stops
 * this in its own words rather than losing commits I have not pushed.
 */
export const fixWorktree = Effect.fn("git.fixWorktree")(function* (repo: string, number: number, prBranch: string) {
  const { clone, directory, head } = yield* whereToCut(repo, number, "fixes")
  const branch = `dw-mc/fix/${number}`

  if ((yield* worktreesOf(clone)).includes(directory)) {
    const ahead = yield* aheadOf(clone, branch, head)
    if (ahead > 0) {
      return yield* new WorktreeHeld({
        directory,
        detail:
          `The last fix session on ${repo}#${number} left ${ahead} commit${ahead === 1 ? "" : "s"} ` +
          `that the pull request's head does not have. Push them or drop them before opening another session.`
      })
    }
    yield* git(["-C", clone, "worktree", "remove", directory])
  }
  yield* git(["-C", clone, "worktree", "add", "-B", branch, directory, head])

  // What makes `git push` inside the session land on the pull request: the
  // branch tracks the pull request's, and a push follows the upstream's name
  // rather than the branch's own.
  yield* git(["-C", clone, "config", `branch.${branch}.remote`, "origin"])
  yield* git(["-C", clone, "config", `branch.${branch}.merge`, `refs/heads/${prBranch}`])
  yield* git(["-C", clone, "config", "push.default", "upstream"])

  return { directory, head } satisfies Worktree
})
