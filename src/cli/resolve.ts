import { Console, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import { steeredSession } from "#adapters/claude.ts"
import { openPrs, prView, viewer } from "#adapters/gh.ts"
import { rebaseInPlace, standingWorktree } from "#adapters/git.ts"
import { Paint } from "#adapters/paint.ts"
import { following, opener, print, retype, stoppedOn } from "#cli/block.ts"
import { asUserError, userFacingAndSession } from "#cli/exit.ts"
import { forPr, prArgument, reading, refuse } from "#cli/pr.ts"
import { conflictFor, stackOf } from "#domain/rebase.ts"
import { decide, promptFor } from "#domain/resolve.ts"

const printFlag = Flag.Boolean("print").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print the prompt a session would open on, and open none")
)

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
    function* ({ pr, print: promptOnly }) {
      const { number, repo, launcher } = yield* forPr(pr)

      const [view, open, me] = yield* reading(
        `${repo}#${number}`,
        Effect.all([prView(repo, number), openPrs(repo), viewer])
      )
      const conflict = yield* conflictFor(repo, number)

      yield* refuse(
        decide({
          repo,
          number,
          mine: view.author?.login === me,
          fromFork: view.isCrossRepository,
          listed: open.some((it) => it.number === number),
          stack: stackOf(number, open),
          head: view.headRefOid,
          conflictAt: conflict === null ? null : conflict.head
        })
      )

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
      if (promptOnly) {
        yield* Console.log(yield* promptFor(conflicted(conflict?.paths ?? [])))
        return
      }

      const paint = yield* Paint
      const worktree = yield* standingWorktree(repo, number, view.headRefName, "rebase")
      yield* print([
        opener(
          paint,
          repo,
          number,
          view.headRefOid,
          `replaying onto ${view.baseRefName} in ${paint.dim(worktree.directory)}`
        )
      ])
      const reviewNext = `Once you have pushed, dw-mc review ${number} reviews the new head as a new run.`

      const stopped = yield* rebaseInPlace(worktree.directory, view.baseRefName)
      if (stopped._tag === "replayed") {
        yield* print(
          following([
            [
              `The replay went through, so there is nothing to resolve: git replayed a resolution you made before, ` +
                `or the conflict is gone.`,
              `The worktree stands where it replayed, and the push onto ${view.headRefName} is yours:`
            ],
            retype(paint, `cd ${worktree.directory}`, `git push`),
            [reviewNext]
          ])
        )
        return
      }

      yield* print(following([stoppedOn(paint, stopped.paths)]))

      const ended = yield* steeredSession({
        launcher,
        directory: worktree.directory,
        prompt: yield* promptFor(conflicted(stopped.paths))
      })

      // What is left to do is what is left to run, so it is on screen as
      // itself: the rebase is finished and pushed by me, from the worktree,
      // and a sentence about it is one more thing to translate.
      yield* print(
        following([
          [
            ended === 0 ? "The session is over." : `The session ended with ${ended}.`,
            "Nothing was committed or pushed for you; the rebase stands where it stopped."
          ],
          retype(paint, `cd ${worktree.directory}`, `git rebase --continue`, `git push`),
          [reviewNext]
        ])
      )
    },
    Effect.catchTag(userFacingAndSession, asUserError)
  )
).pipe(Command.withDescription("Open a session on the conflict that stopped a rebase, in a worktree of my own"))
