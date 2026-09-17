import { Console, Effect, Option } from "effect"
import { CliError, Command } from "effect/unstable/cli"

import { failedRuns, rerunFailed, rollupState } from "#adapters/ci.ts"
import type { ConfigFile } from "#adapters/config.ts"
import { read as readConfig, settingsFor } from "#adapters/config.ts"
import { prView, viewer } from "#adapters/gh.ts"
import { named, prArgument } from "#cli/pr.ts"
import { asUserError, userFacing } from "#cli/sweep.ts"
import { count } from "#cli/table.ts"
import { classify, evidenceFor } from "#domain/flaky.ts"
import type { Situation } from "#domain/rerun.ts"
import { decide, recordRerun, rerunFor } from "#domain/rerun.ts"
import { short } from "#domain/review.ts"

/** The domain's word on a red CI that is not one to re-run, as the command's own failure. */
const allowed = (situation: Situation) => {
  const refused = decide(situation)
  return refused === null ? Effect.void : Effect.fail(new CliError.UserError({ cause: refused }))
}

/**
 * Runs a flaky CI again, once, and never a CI that is mine to fix.
 *
 * This is the second of the two writes the tool makes to GitHub (ADR 0002), and
 * it is the smaller one: `gh run rerun --failed` starts the jobs that failed
 * over on a workflow run of a pull request I author. No comment, reply, thread
 * resolve, label, review, approval, status or merge, here or anywhere.
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
      const file: ConfigFile = Option.getOrElse(yield* readConfig, (): ConfigFile => ({}))
      const { number, repo } = yield* named(pr, Object.keys(file.repos ?? {}).toSorted())
      const settings = settingsFor(file, repo)

      const view = yield* prView(repo, number)
      const me = yield* viewer

      const checks = rollupState(view.statusCheckRollup, settings.ci.ignore)
      // The classifier costs several reads of GitHub, so it is asked only where
      // there is a red CI for it to have an opinion about.
      const flaky =
        checks !== "red"
          ? null
          : yield* Effect.map(evidenceFor(repo, number, view.statusCheckRollup, settings.ci.ignore), (evidence) => {
              const verdict = classify(evidence, settings.ci.flaky_patterns)
              return verdict.classification === "flaky" ? verdict.reason : null
            })

      const runs = failedRuns(view.statusCheckRollup, settings.ci.ignore)
      yield* allowed({
        repo,
        number,
        head: view.headRefOid,
        mine: view.author?.login === me,
        checks,
        flaky,
        rerunAt: yield* rerunFor(repo, number),
        runs
      })

      yield* recordRerun(repo, number, view.headRefOid)
      yield* Effect.forEach(runs, (run) => rerunFailed(repo, run))

      const where = `${repo}#${number}`
      yield* Console.log(
        `${where}  ${short(view.headRefOid)}  re-ran the failed jobs of ${count(runs.length, "workflow run")}`
      )
      yield* Console.log(`It is flaky because ${flaky}.`)
      yield* Console.log(`This head gets no second re-run; if it fails again, the failure is yours.`)
    },
    Effect.catchTag(userFacing, asUserError)
  )
).pipe(Command.withDescription("Run a flaky red CI again, once per head"))
