import { Effect } from "effect"
import { Command } from "effect/unstable/cli"

import { rollupState } from "#adapters/ci.ts"
import { mergeabilityOf, mergePr, prView, reviewDecisionOf, viewer } from "#adapters/gh.ts"
import { Paint } from "#adapters/paint.ts"
import { following, opener, print, separated } from "#cli/block.ts"
import { asUserError, userFacing } from "#cli/exit.ts"
import { forgetting } from "#cli/forget.ts"
import { forPr, prArgument, reading, refuse } from "#cli/pr.ts"
import { decide } from "#domain/merge.ts"
import { reviewedAt } from "#domain/review.ts"
import { withdrawnAt } from "#domain/stamp.ts"

/**
 * Lands one pull request of mine: squashed, with its branch deleted.
 *
 * This is the write ADR 0008 is about, and the only one the tool makes that no
 * reflog of mine brings back. It is outside ADR 0002's three because it moves a
 * shared branch; everything 0002 bars - comment, reply, thread resolve, label,
 * review, approval, status - still holds here as it does everywhere.
 *
 * The threshold is two bars at one head: Ready, which is GitHub's opinion, and
 * my stamp, which is mine. Each is blind to what the other sees, so the write
 * that cannot be undone clears both.
 *
 * GitHub's half is read live from a fresh `pr view` rather than off the last
 * sweep, the way the rebase and re-run guards are. A stale verdict costs a
 * re-run some CI minutes; here it costs merging code nobody read. My half comes
 * from the state directory, because the review runs and the withdrawal live
 * there and are already scoped to the head this read just named.
 *
 * Typing the command is the confirmation, so it takes no flag. The picker,
 * where a keystroke is cheaper, asks before it dispatches.
 *
 * Its last step is forgetting the pull request, in every namespace. A session
 * worktree standing on it stays, and is named, because its branch tracked the
 * one this just deleted.
 */
export const merge = Command.make(
  "merge",
  { pr: prArgument },
  Effect.fn("merge")(
    function* ({ pr }) {
      const { number, repo, settings } = yield* forPr(pr)

      const [view, me] = yield* reading(`${repo}#${number}`, Effect.all([prView(repo, number), viewer]))

      const head = view.headRefOid

      yield* refuse(
        decide({
          repo,
          number,
          head,
          mine: view.author?.login === me,
          draft: view.isDraft,
          reviewDecision: reviewDecisionOf(view.reviewDecision),
          checks: rollupState(view.statusCheckRollup, settings.ci.ignore),
          mergeable: mergeabilityOf(view.mergeable),
          ...(yield* reviewedAt(repo, number, head, settings.stamp.blocks_on)),
          withdrawnAt: yield* withdrawnAt(repo, number)
        })
      )

      yield* mergePr(repo, number)

      const paint = yield* Paint
      yield* print(
        separated([
          [
            opener(paint, repo, number, head, `squash-merged into ${view.baseRefName}, and ${view.headRefName} deleted`)
          ],
          [`The squash subject is the pull request title: ${paint.dim(view.title)}`]
        ])
      )

      // The one moment the tool knows a pull request is finished rather than
      // guessing it, so the records go here and nowhere else automatic.
      // The merge has happened by now, so a forget that fails says so beside it
      // rather than turning a landed pull request into a failed command.
      const forgot = yield* forgetting(repo, number, { deleted: view.headRefName }).pipe(
        Effect.catch((error) =>
          Effect.succeed([
            [`Could not forget ${repo}#${number}: ${error.message}. Run dw-mc forget ${number} to try again.`]
          ])
        )
      )
      yield* print(following(forgot))
    },
    Effect.catchTag(userFacing, asUserError)
  )
).pipe(Command.withDescription("Squash-merge a Ready, stamped pull request of mine and delete its branch"))
