import { Effect, Result, Schema } from "effect"

import type { Reads } from "#adapters/heartbeat.ts"
import { beating } from "#adapters/heartbeat.ts"
import { capture } from "#adapters/spawner.ts"
import type { Cut, Session } from "#adapters/store.ts"
import { cloneAt, cutAt, pullRef, sessionBranch, under } from "#adapters/store.ts"

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
    return `${this.detail}\nThe fix worktree's directory is ${this.directory}.`
  }
}

/**
 * Where a worktree is cut from, what it is cut at, and where it goes: the tool's
 * own bare clone of `repo`, the pull request's head, and a directory under
 * `cut` in the state directory.
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
/**
 * How the heartbeat of a cut reads.
 *
 * The stages are named apart because a first clone and a hundredth fetch take
 * wildly different times, and the line is what explains the difference: a
 * `cloning` that sits there for two minutes is a large repository arriving
 * once, not a tool that has hung.
 */
const cutting =
  (what: string, repo: string): Reads =>
  (since) =>
    `${what} ${repo} · ${since}`

const whereToCut = Effect.fn("git.whereToCut")(function* (repo: string, number: number, cut: Cut) {
  const clone = yield* cloneAt(repo)

  const bare = yield* Effect.orElseSucceed(git(["-C", clone, "rev-parse", "--is-bare-repository"]), () => "")
  const ref = pullRef(number)

  const head = yield* beating(cutting(bare === "true" ? "fetching" : "cloning", repo), (says) =>
    Effect.gen(function* () {
      if (bare !== "true") {
        yield* git(["clone", "--bare", "--filter=blob:none", `https://github.com/${repo}.git`, clone])
        yield* says(cutting("fetching", repo))
      }
      yield* git([
        "-C",
        clone,
        "fetch",
        "--no-tags",
        "--force",
        "origin",
        `+refs/pull/${number}/head:${ref}`,
        "+refs/heads/*:refs/heads/*"
      ])
      return yield* git(["-C", clone, "rev-parse", ref])
    })
  )
  return { clone, head, directory: yield* cutAt(cut, repo, number) }
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
    beating(cutting("cutting a worktree of", repo), () =>
      Effect.flatMap(remove, () => git(["-C", clone, "worktree", "add", "--detach", directory, head]))
    ),
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
 * How far the branch a fix session works on has gone past `head`.
 *
 * Asked of the branch and never of the worktree that stands on it: a worktree
 * can be pruned or moved away by hand, and the branch it left behind still
 * holds the commits. A branch that is not there yet is nothing to hold.
 */
const aheadOf = Effect.fn("git.aheadOf")(function* (clone: string, branch: string, head: string) {
  const ref = `refs/heads/${branch}`
  const found = yield* Effect.orElseSucceed(git(["-C", clone, "rev-parse", "--verify", "--quiet", ref]), () => "")
  if (found === "") {
    return 0
  }
  const counted = yield* git(["-C", clone, "rev-list", "--count", ref, `^${head}`])
  return Number(counted.trim())
})

/**
 * The clone, ready to keep a setting per worktree rather than for all of them.
 *
 * Verified by running it: turning `extensions.worktreeConfig` on in a bare
 * repository makes its linked worktrees read `core.bare` too, and every one of
 * them then refuses to work as a checkout. Git's own answer is to move
 * `core.bare` into the main worktree's config, which is what these three lines
 * do. `--unset` on a key already moved is not a failure, it is the second run.
 */
const perWorktreeConfig = Effect.fn("git.perWorktreeConfig")(function* (clone: string) {
  yield* git(["-C", clone, "config", "extensions.worktreeConfig", "true"])
  yield* git(["-C", clone, "config", "--worktree", "core.bare", "true"])
  yield* Effect.ignore(git(["-C", clone, "config", "--unset", "core.bare"]))
})

/**
 * Turns the clone's reuse of a resolution on, which is what the session on a
 * conflict is worth beyond the one conflict.
 *
 * The recording lives in the clone rather than in the worktree, so a conflict I
 * resolve here is one `git` replays by itself the next time a throwaway rebase
 * hits it, with no model involved at all. `autoUpdate` is what makes that a
 * replay rather than a reminder: without it the resolution is written into the
 * worktree and left unstaged, and the rebase stops on a file that is already
 * resolved.
 */
const reuseResolutions = Effect.fn("git.reuseResolutions")(function* (clone: string) {
  yield* git(["-C", clone, "config", "rerere.enabled", "true"])
  yield* git(["-C", clone, "config", "rerere.autoUpdate", "true"])
})

/**
 * A worktree for a session I steer, on a branch of the tool's own, and left
 * standing when the session ends.
 *
 * It outlives the session because the work in it is mine: I commit and push
 * from inside the session, and a worktree taken down at the end would take an
 * unpushed commit with it.
 *
 * The branch is `dw-mc/<session>/<number>` and never the pull request's own,
 * which is verified rather than a preference: `git` refuses to fetch into a
 * branch that a worktree has checked out, so a worktree standing on the pull
 * request's branch would fail the next fetch of this clone and take every
 * command that reads it down with it. It carries the session's name because a
 * fix session and a session on a conflict stand at the same time on the same
 * pull request, and one branch between them would be one holding the other's
 * commits. The branch tracks the pull request's, so a plain `git push` from
 * inside the session lands on the pull request.
 *
 * A previous session's work stops this before anything is cut: a branch that
 * has gone past the head says so in its own words rather than being reset over
 * commits I have not pushed, and that is asked of the branch alone, so a
 * worktree pruned or removed by hand does not let the commits through. Where
 * the branch is clear, the previous worktree is removed without `--force`, so
 * changes I have not committed refuse in `git`'s own words.
 */
export const standingWorktree = Effect.fn("git.standingWorktree")(function* (
  repo: string,
  number: number,
  prBranch: string,
  session: Session
) {
  const { clone, directory, head } = yield* whereToCut(repo, number, under[session])
  const branch = sessionBranch(session, number)

  const ahead = yield* aheadOf(clone, branch, head)
  if (ahead > 0) {
    return yield* new WorktreeHeld({
      directory,
      detail:
        `The last fix session on ${repo}#${number} left ${ahead} commit${ahead === 1 ? "" : "s"} ` +
        `that the pull request's head does not have. Push them or drop them before opening another session.`
    })
  }
  if ((yield* worktreesOf(clone)).includes(directory)) {
    yield* git(["-C", clone, "worktree", "remove", directory])
  }
  yield* perWorktreeConfig(clone)
  if (session === "rebase") {
    yield* reuseResolutions(clone)
  }
  yield* beating(cutting("cutting a worktree of", repo), () =>
    git(["-C", clone, "worktree", "add", "-B", branch, directory, head])
  )

  // What makes `git push` inside the session land on the pull request: the
  // branch tracks the pull request's, and a push follows the upstream's name
  // rather than the branch's own. Where the branch is tracked is the clone's
  // business, but how a push behaves is this worktree's alone: a review run's
  // worktree must not inherit it.
  yield* git(["-C", clone, "config", `branch.${branch}.remote`, "origin"])
  yield* git(["-C", clone, "config", `branch.${branch}.merge`, `refs/heads/${prBranch}`])
  yield* git(["-C", directory, "config", "--worktree", "push.default", "upstream"])

  return { directory, head } satisfies Worktree
})

/** What a rebase of a pull request's branch onto its base came to. */
export type Rebased =
  | { readonly _tag: "up-to-date" }
  | { readonly _tag: "conflicted"; readonly paths: ReadonlyArray<string> }
  | { readonly _tag: "pushed"; readonly before: string; readonly after: string; readonly behind: number }

/** How many commits the base has that the worktree's head does not. */
const behindBy = Effect.fn("git.behindBy")(function* (directory: string, base: string) {
  const counted = yield* git(["-C", directory, "rev-list", "--count", `HEAD..refs/heads/${base}`])
  return Number(counted.trim())
})

/**
 * The files the stopped replay left unmerged, which is what the conflict is
 * about.
 *
 * `git` names them itself rather than being read out of its prose, and a
 * listing that refuses is no reason to leave a rebase standing: the paths are
 * worth less than the abort, so the conflict is recorded with none of them.
 */
const unmergedIn = Effect.fn("git.unmergedIn")(function* (directory: string) {
  const listed = yield* Effect.orElseSucceed(git(["-C", directory, "diff", "--name-only", "--diff-filter=U"]), () => "")
  return listed.split("\n").filter((line) => line !== "")
})

/** What replaying a branch's commits onto its base came to, inside the worktree. */
type Replayed = { readonly _tag: "replayed" } | { readonly _tag: "conflicted"; readonly paths: ReadonlyArray<string> }

/**
 * Whether a rebase is in progress in `directory`.
 *
 * Asked of `git` by the one command that answers it with an exit code alone:
 * the stopped replay's patch is there to show while the rebase is, and gone
 * when it is not.
 */
const rebasing = Effect.fn("git.rebasing")(function* (directory: string) {
  return Result.isSuccess(yield* Effect.result(git(["-C", directory, "rebase", "--show-current-patch"])))
})

/** Whether anything is staged in `directory`, which `git` says by refusing. */
const stagedIn = Effect.fn("git.stagedIn")(function* (directory: string) {
  return Result.isFailure(yield* Effect.result(git(["-C", directory, "diff", "--cached", "--quiet"])))
})

/**
 * How many stops one replay may be carried past before this gives up on it.
 *
 * A replay of n commits can stop n times and `rerere` can answer every one of
 * them, so the number is only here so that a stop which neither resolves nor
 * moves cannot spin forever.
 */
const stops = 100

/**
 * Replays the worktree's commits onto `base`, and says where the replay
 * stopped: nowhere, or on the files it could not merge.
 *
 * A conflict is told from every other way `git rebase` refuses by what it left
 * unmerged, which `git` names itself rather than being read out of its prose.
 * The unmerged files are read before anything is aborted, because that is the
 * only moment they exist.
 *
 * A stop with nothing unmerged is where `rerere` has been: verified by running
 * it, a replay of a conflict I resolved once stages the old resolution and
 * still exits non-zero, with no unmerged file left to name. That is a replay to
 * carry on rather than one to report, so it is continued - with `core.editor`
 * off, because the continue is the tool's and the message is the commit's own.
 * Anything else with nothing unmerged and nothing staged never started, and is
 * worth `git`'s own words rather than a conflict that did not happen.
 *
 * `onConflict` is the whole difference between the two worktrees that replay.
 * `abort` is for the one the tool cuts and throws away, where nothing
 * half-finished may be left behind; `leave` is for the one I asked for and
 * which stands, where the stopped rebase is what I came for.
 */
const replayOnto = Effect.fn("git.replayOnto")(function* (
  directory: string,
  base: string,
  onConflict: "abort" | "leave"
) {
  let stopped = yield* Effect.result(git(["-C", directory, "rebase", `refs/heads/${base}`]))

  for (let step = 0; step < stops; step += 1) {
    if (Result.isSuccess(stopped)) {
      return { _tag: "replayed" } satisfies Replayed
    }
    const paths = yield* unmergedIn(directory)
    if (paths.length > 0) {
      if (onConflict === "abort") {
        const aborted = yield* Effect.result(git(["-C", directory, "rebase", "--abort"]))
        if (Result.isFailure(aborted)) {
          return yield* stopped.failure
        }
      }
      return { _tag: "conflicted", paths } satisfies Replayed
    }
    if (!((yield* rebasing(directory)) && (yield* stagedIn(directory)))) {
      return yield* stopped.failure
    }
    stopped = yield* Effect.result(git(["-C", directory, "-c", "core.editor=true", "rebase", "--continue"]))
  }

  return Result.isSuccess(stopped) ? ({ _tag: "replayed" } satisfies Replayed) : yield* stopped.failure
})

/**
 * Replays onto `base` in a worktree that stands, and leaves a conflict exactly
 * where it stopped.
 *
 * This is the other half of the rebase the throwaway worktree aborts: the
 * conflict is the point here, so the rebase stays in progress and the files
 * stay unmerged for the session to work on and for me to finish. The two are
 * not the same invariant - nothing half-finished is left in a worktree the tool
 * cuts and throws away, and this one is mine, asked for and left standing.
 */
export const rebaseInPlace = Effect.fn("git.rebaseInPlace")(function* (directory: string, base: string) {
  return yield* replayOnto(directory, base, "leave")
})

/**
 * Brings a pull request's branch up to date with its base: rebase onto the
 * base and push with a lease, in a worktree thrown away either way.
 *
 * This is the only write the tool makes to GitHub, and everything about how it
 * is done is about that. The lease names the commit the rebase started from,
 * so a push lands only where the branch is still where this run read it, and a
 * commit pushed from somewhere else while the rebase ran refuses rather than
 * being overwritten. The branch is named in full on both sides of the push,
 * because the worktree stands on a detached head and has no branch of its own
 * to push from.
 *
 * My own checkout is not involved: the worktree is cut from the tool's own
 * clone, like every other run's.
 */
export const rebaseOnto = Effect.fn("git.rebaseOnto")(function* (
  repo: string,
  number: number,
  base: string,
  branch: string
) {
  return yield* withWorktree(repo, number, (worktree) =>
    Effect.gen(function* () {
      const behind = yield* behindBy(worktree.directory, base)
      if (behind === 0) {
        return { _tag: "up-to-date" } satisfies Rebased
      }
      const replayed = yield* replayOnto(worktree.directory, base, "abort")
      if (replayed._tag === "conflicted") {
        return replayed satisfies Rebased
      }

      const after = yield* git(["-C", worktree.directory, "rev-parse", "HEAD"])
      yield* git([
        "-C",
        worktree.directory,
        "push",
        `--force-with-lease=refs/heads/${branch}:${worktree.head}`,
        "origin",
        `HEAD:refs/heads/${branch}`
      ])
      return { _tag: "pushed", before: worktree.head, after, behind } satisfies Rebased
    })
  )
})

/** What a standing session worktree still holds, or nothing at all. */
export type Holding = { readonly _tag: "clear" } | { readonly _tag: "held"; readonly detail: string }

const clear: Holding = { _tag: "clear" }

/**
 * What the worktree of a fix or resolve session still holds, asked without
 * reaching GitHub.
 *
 * Nothing that takes a directory away may fetch first: a command asked to
 * remove things would be cloning to answer whether it may, and a machine that
 * is offline would be told its work is gone. So the pull request's head is read
 * from the ref the last run left in the clone, and where there is no ref to
 * read the answer is that this cannot be told - which holds the worktree rather
 * than letting it through, because the one mistake worth avoiding here is
 * taking away a commit I have not pushed.
 *
 * Uncommitted changes are asked of the worktree and commits are asked of the
 * branch, for the reason `standingWorktree` asks the same two: a worktree
 * pruned or moved by hand still leaves the branch holding the commits.
 */
export const holding = Effect.fn("git.holding")(function* (repo: string, number: number, session: Session) {
  const clone = yield* cloneAt(repo)
  const directory = yield* cutAt(under[session], repo, number)
  const branch = sessionBranch(session, number)

  const changes = yield* Effect.orElseSucceed(git(["-C", directory, "status", "--porcelain"]), () => "")
  if (changes.trim() !== "") {
    return { _tag: "held", detail: "changes that are not committed" } satisfies Holding
  }

  const ref = `refs/heads/${branch}`
  const found = yield* Effect.orElseSucceed(git(["-C", clone, "rev-parse", "--verify", "--quiet", ref]), () => "")
  if (found.trim() === "") {
    return clear
  }

  const head = yield* Effect.orElseSucceed(git(["-C", clone, "rev-parse", pullRef(number)]), () => "")
  if (head.trim() === "") {
    return {
      _tag: "held",
      detail: `the clone no longer knows what ${repo}#${number} points at, so what ${branch} holds cannot be told`
    } satisfies Holding
  }

  const ahead = yield* aheadOf(clone, branch, head.trim())
  return ahead === 0
    ? clear
    : ({
        _tag: "held",
        detail: `${ahead} commit${ahead === 1 ? "" : "s"} that the pull request's head does not have`
      } satisfies Holding)
})

/**
 * Forgets the worktrees a clone has been left with, once their directories are
 * gone.
 *
 * A directory taken from under the clone leaves the clone's record of it
 * behind, and the next session on that pull request is cut at the same path,
 * which is then refused as already registered. Pruning is the whole repair, and
 * only a clone that stays needs it: one being removed takes its records with
 * it.
 */
export const prune = Effect.fn("git.prune")(function* (clone: string) {
  yield* Effect.ignore(git(["-C", clone, "worktree", "prune"]))
})
