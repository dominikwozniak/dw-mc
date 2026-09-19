import { Effect } from "effect"
import { Command } from "effect/unstable/cli"

import { failedRuns, rerunFailed, rollupState } from "#adapters/ci.ts"
import { prView, viewer } from "#adapters/gh.ts"
import { Paint } from "#adapters/paint.ts"
import { opener, print, separated } from "#cli/block.ts"
import { asUserError, userFacing } from "#cli/exit.ts"
import { forPr, prArgument, reading, refuse } from "#cli/pr.ts"
import { count } from "#cli/table.ts"
import { flakyReason } from "#domain/flaky.ts"
import { decide, recordRerun, refusedUnclassified, rerunFor } from "#domain/rerun.ts"

/**
 * Runs a flaky CI again, once, and never a CI that is mine to fix.
 *
 * This is the lighter of the two writes ADR 0002 admits: `gh run rerun
 * --failed` starts the jobs that failed over on a workflow run of a pull
 * request I author. No comment, reply, thread resolve, label, review, approval
 * or status, here or anywhere. The merge is a write of its own and lives in
 * `dw-mc merge` alone (ADR 0008).
 *
 * Every signal is read live rather than off the last sweep, for the reason the
 * rebase guards are: a verdict from ten minutes ago can be about a head that
 * has gone, and spending CI minutes on that is spending them on nothing.
 *
 * The head is written down before a single run is asked for, because the cap is
 * what keeps this from looping and a cap a crash can lose is no cap. The cost of
 * getting it wrong that way is one re-run I have to ask for again; the other way
 * it is a pull request re-running itself until the minutes run out.
 */
export const rerun = Command.make(
  "rerun",
  { pr: prArgument },
  Effect.fn("rerun")(
    function* ({ pr }) {
      const { number, repo, settings } = yield* forPr(pr)

      const [view, me] = yield* reading(`${repo}#${number}`, Effect.all([prView(repo, number), viewer]))

      const unclassified = {
        repo,
        number,
        head: view.headRefOid,
        mine: view.author?.login === me,
        checks: rollupState(view.statusCheckRollup, settings.ci.ignore),
        rerunAt: yield* rerunFor(repo, number),
        runs: failedRuns(view.statusCheckRollup, settings.ci.ignore)
      }
      // Asking the classifier costs a handful of reads of GitHub and up to
      // three job logs, so the guards that cost nothing are asked first: a
      // head that has had its re-run is refused without paying for a verdict
      // about it.
      yield* refuse(refusedUnclassified(unclassified))

      const flaky = yield* flakyReason(
        repo,
        number,
        view.statusCheckRollup,
        settings.ci.ignore,
        settings.ci.flaky_patterns
      )
      yield* refuse(decide({ ...unclassified, flaky }))

      yield* recordRerun(repo, number, view.headRefOid)
      yield* Effect.forEach(unclassified.runs, (run) => rerunFailed(repo, run))

      const paint = yield* Paint
      yield* print(
        separated([
          [
            opener(
              paint,
              repo,
              number,
              view.headRefOid,
              `re-ran the failed jobs of ${count(unclassified.runs.length, "workflow run")}`
            )
          ],
          [`It is flaky because ${flaky}.`, `This head gets no second re-run; if it fails again, the failure is yours.`]
        ])
      )
    },
    Effect.catchTag(userFacing, asUserError)
  )
).pipe(Command.withDescription("Run a flaky red CI again, once per head"))
