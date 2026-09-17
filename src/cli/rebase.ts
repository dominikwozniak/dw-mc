import { Console, Effect, Option } from "effect"
import { CliError, Command } from "effect/unstable/cli"

import { rollupState } from "#adapters/ci.ts"
import type { ConfigFile } from "#adapters/config.ts"
import { read as readConfig, settingsFor } from "#adapters/config.ts"
import { openPrs, prView, viewer } from "#adapters/gh.ts"
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
 * push to a branch I author, in the repository the branch is in, with a lease,
 * onto the head this run read (ADR 0002). Who opened the pull request and where
 * its branch lives are read from GitHub and checked before anything is cut. No comment, reply, thread resolve, label, review, approval, status or
 * merge, here or anywhere.
 *
 * Every guard is read live rather than off the last sweep, because each of them
 * is about the branch as it is now: a sweep from ten minutes ago cannot say
 * whether CI is running, and a rebase decided on that would cancel the run I am
 * waiting on.
 *
 * A conflict is written down against the head it conflicted at, with the files
 * it stopped on, which puts the pull request in Needs me until the branch
 * moves. The files are what makes it something to open, and `dw-mc resolve` is
 * what opens it - said here, because a conflict is where the next step stops
 * being obvious, and never taken here, because a session is opened when I ask
 * for one. Nothing half-finished is left behind either way: the rebase aborts
 * and the worktree it ran in goes with the run.
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
      const me = yield* viewer

      yield* allowed({
        repo,
        number,
        base: view.baseRefName,
        enabled: settings.rebase.enabled,
        mine: view.author?.login === me,
        fromFork: view.isCrossRepository,
        listed: open.some((it) => it.number === number),
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
        yield* recordConflict(repo, number, view.headRefOid, done.paths)
        yield* Console.log(
          `${where}  ${short(view.headRefOid)}  the rebase onto ${view.baseRefName} conflicted, ` +
            `so it was aborted and nothing was pushed.`
        )
        if (done.paths.length > 0) {
          yield* Console.log(`It stopped on ${count(done.paths.length, "file")}:`)
          yield* Effect.forEach(done.paths, (path) => Console.log(`  ${path}`))
        }

        // A conflict is where the next step stops being obvious, so the step is
        // on screen as itself. Nothing follows it on its own: the session is
        // opened when I ask for it and never because a rebase stopped.
        yield* Effect.forEach([``, `  dw-mc resolve ${number}`, ``], (line) => Console.log(line))
        yield* Console.log(
          `That opens a session on the conflict, in a worktree of your own. ` +
            `The next sweep puts it in Needs me, and it stays there until the branch moves.`
        )
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
