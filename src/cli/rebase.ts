import { Console, Effect, Option } from "effect"
import { CliError, Command } from "effect/unstable/cli"

import { rollupState } from "#adapters/ci.ts"
import type { ConfigFile } from "#adapters/config.ts"
import { read as readConfig, settingsFor } from "#adapters/config.ts"
import { openPrs, prView } from "#adapters/gh.ts"
import { rebaseOnto } from "#adapters/git.ts"
import { named, prArgument } from "#cli/pr.ts"
import { asUserError, userFacing } from "#cli/sweep.ts"
import { count } from "#cli/table.ts"
import type { Situation } from "#domain/rebase.ts"
import { decide, recordConflict, stackOf } from "#domain/rebase.ts"
import { short } from "#domain/review.ts"

/** The domain's word on a branch that is not one to rebase, as the command's own failure. */
const allowed = (situation: Situation) => {
  const refused = decide(situation)
  return refused === null ? Effect.void : Effect.fail(new CliError.UserError({ cause: refused }))
}

/**
 * Brings one branch up to date with its base, with the guards that matter more
 * than the rebase does.
 *
 * This is the only place the tool writes to GitHub, and it writes one thing: a
 * push to a branch I author, with a lease, onto the head this run read (ADR
 * 0002). No comment, reply, thread resolve, label, review, approval, status or
 * merge, here or anywhere.
 *
 * Every guard is read live rather than off the last sweep, because each of them
 * is about the branch as it is now: a sweep from ten minutes ago cannot say
 * whether CI is running, and a rebase decided on that would cancel the run I am
 * waiting on.
 *
 * A conflict is written down against the head it conflicted at, which puts the
 * pull request in Needs me until the branch moves. Nothing half-finished is
 * left behind either way: the rebase aborts and the worktree it ran in goes
 * with the run.
 *
 * A stack is recognised and never driven. The tool does not understand stacks,
 * so what it has to say about one is where the pull request sits in it.
 */
export const rebase = Command.make(
  "rebase",
  { pr: prArgument },
  Effect.fn("rebase")(
    function* ({ pr }) {
      const file: ConfigFile = Option.getOrElse(yield* readConfig, (): ConfigFile => ({}))
      const { number, repo } = yield* named(pr, Object.keys(file.repos ?? {}).toSorted())
      const settings = settingsFor(file, repo)

      const view = yield* prView(repo, number)
      const open = yield* openPrs(repo)

      yield* allowed({
        repo,
        number,
        base: view.baseRefName,
        enabled: settings.rebase.enabled,
        checks: rollupState(view.statusCheckRollup, settings.ci.ignore),
        stack: stackOf(number, open)
      })

      const where = `${repo}#${number}`
      const done = yield* rebaseOnto(repo, number, view.baseRefName, view.headRefName)

      if (done._tag === "up-to-date") {
        yield* Console.log(`${where}  ${short(view.headRefOid)}  already on ${view.baseRefName}`)
        return
      }
      if (done._tag === "conflicted") {
        yield* recordConflict(repo, number, view.headRefOid)
        yield* Console.log(
          `${where}  ${short(view.headRefOid)}  the rebase onto ${view.baseRefName} conflicted, ` +
            `so it was aborted and nothing was pushed.`
        )
        yield* Console.log("It is in Needs me until you resolve it and the branch moves.")
        return
      }

      yield* Console.log(
        `${where}  ${short(done.before)} → ${short(done.after)}  ` +
          `rebased ${count(done.behind, "commit")} of ${view.baseRefName} and pushed with a lease`
      )
    },
    Effect.catchTag([...userFacing, "GitFailed"], asUserError)
  )
).pipe(Command.withDescription("Rebase one branch onto its base and push it with a lease"))
