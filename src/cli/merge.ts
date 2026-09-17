import { Console, Effect, Option } from "effect"
import { Command } from "effect/unstable/cli"

import { rollupState } from "#adapters/ci.ts"
import type { ConfigFile } from "#adapters/config.ts"
import { read as readConfig, settingsFor } from "#adapters/config.ts"
import { mergeabilityOf, mergePr, prView, reviewDecisionOf, viewer } from "#adapters/gh.ts"
import { named, prArgument, refuse } from "#cli/pr.ts"
import { asUserError, userFacing } from "#cli/sweep.ts"
import { decide } from "#domain/merge.ts"
import { reviewedAt, short } from "#domain/review.ts"
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
 */
export const merge = Command.make(
  "merge",
  { pr: prArgument },
  Effect.fn("merge")(
    function* ({ pr }) {
      const file: ConfigFile = Option.getOrElse(yield* readConfig, (): ConfigFile => ({}))
      const { number, repo } = yield* named(pr, Object.keys(file.repos ?? {}).toSorted())
      const settings = settingsFor(file, repo)

      const view = yield* prView(repo, number)
      const me = yield* viewer

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
          ...(yield* reviewedAt(repo, number, head, settings)),
          withdrawnAt: yield* withdrawnAt(repo, number)
        })
      )

      yield* mergePr(repo, number)

      yield* Console.log(
        `${repo}#${number}  ${short(head)}  squash-merged into ${view.baseRefName}, ` +
          `and ${view.headRefName} deleted`
      )
      yield* Console.log(`The squash subject is the pull request title: ${view.title}`)
    },
    Effect.catchTag(userFacing, asUserError)
  )
).pipe(Command.withDescription("Squash-merge a Ready, stamped pull request of mine and delete its branch"))
