import { Console, Effect, Option } from "effect"
import { CliError, Command, Flag } from "effect/unstable/cli"

import { steeredSession } from "#adapters/claude.ts"
import type { ConfigFile } from "#adapters/config.ts"
import { launcherOf, read as readConfig } from "#adapters/config.ts"
import { openPrs, prView, viewer } from "#adapters/gh.ts"
import { rebaseInPlace, standingWorktree } from "#adapters/git.ts"
import { named, prArgument } from "#cli/pr.ts"
import { asUserError, userFacing } from "#cli/sweep.ts"
import { count } from "#cli/table.ts"
import { conflictFor, stackOf } from "#domain/rebase.ts"
import type { Situation } from "#domain/resolve.ts"
import { decide, promptFor } from "#domain/resolve.ts"
import { short } from "#domain/review.ts"

const printFlag = Flag.Boolean("print").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print the prompt a session would open on, and open none")
)

/** The domain's word on a conflict that is not one to open, as the command's own failure. */
const allowed = (situation: Situation) => {
  const refused = decide(situation)
  return refused === null ? Effect.void : Effect.fail(new CliError.UserError({ cause: refused }))
}

/**
 * A session on the conflict that stopped a rebase, in a worktree that is mine.
 *
 * `dw-mc rebase` is untouched by this: it aborts, pushes nothing and leaves no
 * partial state. This is the deliberate step afterwards, and it redoes the
 * rebase itself rather than inheriting a half-finished one - the worktree here
 * is one I asked for and it stands, so a rebase in progress in it is the whole
 * point rather than a broken invariant.
 *
 * The tool resolves nothing. It replays onto the base, shows what the replay
 * stopped on and hands an interactive session what conflicted and what the pull
 * request is for; then it is out of the way. Finishing the rebase, committing
 * and pushing are mine, from the worktree, which is why the worktree outlives
 * the session. Nothing here writes to GitHub.
 *
 * `rerere` is turned on in the clone before the replay, so the resolution I
 * make once is one `git` replays by itself the next time a rebase hits it, with
 * no model involved at all. That is also why a replay can go through with
 * nothing to resolve.
 */
export const resolve = Command.make(
  "resolve",
  { pr: prArgument, print: printFlag },
  Effect.fn("resolve")(
    function* ({ pr, print }) {
      const file: ConfigFile = Option.getOrElse(yield* readConfig, (): ConfigFile => ({}))
      const { number, repo } = yield* named(pr, Object.keys(file.repos ?? {}).toSorted())

      const view = yield* prView(repo, number)
      const open = yield* openPrs(repo)
      const me = yield* viewer
      const conflict = yield* conflictFor(repo, number)

      yield* allowed({
        repo,
        number,
        mine: view.author?.login === me,
        fromFork: view.isCrossRepository,
        listed: open.some((it) => it.number === number),
        stack: stackOf(number, open),
        head: view.headRefOid,
        conflictAt: conflict === null ? null : conflict.head
      })

      /** The conflict as the prompt takes it, around whichever paths are known by then. */
      const conflicted = (paths: ReadonlyArray<string>) => ({
        repo,
        number,
        head: view.headRefOid,
        base: view.baseRefName,
        title: view.title,
        paths
      })

      // The prompt on its own, for the session I already have open. Nothing is
      // cut and no replay is run: the paths are the ones the rebase wrote down,
      // which is everything a prompt has to carry.
      if (print) {
        yield* Console.log(yield* promptFor(conflicted(conflict?.paths ?? [])))
        return
      }

      const where = `${repo}#${number}`
      const worktree = yield* standingWorktree(repo, number, view.headRefName, "rebase")
      yield* Console.log(
        `${where}  ${short(view.headRefOid)}  replaying onto ${view.baseRefName} in ${worktree.directory}`
      )

      const stopped = yield* rebaseInPlace(worktree.directory, view.baseRefName)
      if (stopped._tag === "replayed") {
        yield* Console.log(
          `The replay went through, so there is nothing to resolve: git replayed a resolution you made before, ` +
            `or the conflict is gone.`
        )
        yield* Console.log(`The worktree stands where it replayed, and the push onto ${view.headRefName} is yours:`)
        yield* Effect.forEach([``, `  cd ${worktree.directory}`, `  git push`, ``], (line) => Console.log(line))
        yield* Console.log(`Once you have pushed, dw-mc review ${number} reviews the new head as a new run.`)
        return
      }

      yield* Console.log(`It stopped on ${count(stopped.paths.length, "file")}:`)
      yield* Effect.forEach(stopped.paths, (path) => Console.log(`  ${path}`))

      const ended = yield* steeredSession({
        launcher: launcherOf(file),
        directory: worktree.directory,
        prompt: yield* promptFor(conflicted(stopped.paths))
      })

      yield* Console.log(ended === 0 ? "The session is over." : `The session ended with ${ended}.`)
      yield* Console.log("Nothing was committed or pushed for you; the rebase stands where it stopped.")

      // What is left to do is what is left to run, so it is on screen as
      // itself: the rebase is finished and pushed by me, from the worktree,
      // and a sentence about it is one more thing to translate.
      yield* Effect.forEach([``, `  cd ${worktree.directory}`, `  git rebase --continue`, `  git push`, ``], (line) =>
        Console.log(line)
      )
      yield* Console.log(`Once you have pushed, dw-mc review ${number} reviews the new head as a new run.`)
    },
    Effect.catchTag([...userFacing, "GitFailed", "WorktreeHeld", "AgentFailed"], asUserError)
  )
).pipe(Command.withDescription("Open a session on the conflict that stopped a rebase, in a worktree of my own"))
