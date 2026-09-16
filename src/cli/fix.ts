import { Console, Effect, Option } from "effect"
import { CliError, Command } from "effect/unstable/cli"

import type { ConfigFile } from "#adapters/config.ts"
import { read as readConfig, settingsFor } from "#adapters/config.ts"
import { prView } from "#adapters/gh.ts"
import { fixWorktree } from "#adapters/git.ts"
import { choose, note } from "#adapters/picker.ts"
import { fixSession } from "#adapters/runner.ts"
import { currentRun, summary, whatItFound } from "#cli/findings.ts"
import { named, prArgument } from "#cli/pr.ts"
import { asUserError, userFacing } from "#cli/sweep.ts"
import { table } from "#cli/table.ts"
import type { Finding } from "#domain/findings.ts"
import type { Chosen } from "#domain/fix.ts"
import { promptFor } from "#domain/fix.ts"

/** The findings to pick from, each on the line the report gives it. */
const choicesOf = (findings: ReadonlyArray<Finding>) => {
  const titles = table(
    findings.map((finding) => [`${finding.file}:${finding.line}`, finding.severity, finding.summary])
  )
  return findings.map((finding, index) => ({ title: titles[index] ?? finding.summary, value: finding }))
}

/**
 * Each picked finding with whatever I have to say about it.
 *
 * The note is asked for one finding at a time, in the order I see them, and
 * having nothing to say is the ordinary answer rather than a step I have to get
 * past.
 */
const noted = Effect.fn("fix.noted")(function* (picked: ReadonlyArray<Finding>) {
  const chosen: Array<Chosen> = []
  for (const finding of picked) {
    const said = yield* note(`Note on ${finding.file}:${finding.line}, or nothing`)
    chosen.push(Option.match(said, { onNone: () => finding, onSome: (text) => ({ ...finding, note: text }) }))
  }
  return chosen
})

/**
 * The head both the findings and the worktree stand on, or the sentence saying
 * they cannot.
 *
 * A pull request that moved since its last review run has findings at lines
 * that may no longer be there, and a worktree cut at the new head would carry
 * them into code they were never about. Reviewing again is cheap next to fixing
 * the wrong thing.
 */
const sameHead = (number: number, run: string, now: string) =>
  run === now
    ? Effect.void
    : Effect.fail(
        new CliError.UserError({
          cause:
            `The findings are from ${run.slice(0, 7)} and the pull request is now at ${now.slice(0, 7)}. ` +
            `Run dw-mc review ${number} again to review the head you would be fixing.`
        })
      )

/**
 * A fix session: the findings I picked, in an agent session I steer.
 *
 * The tool fixes nothing. It picks the findings apart with me, cuts a worktree
 * on the pull request's branch and hands the session what I chose as JSON, and
 * then it is out of the way: I steer, I commit, I push. Nothing here writes to
 * GitHub and nothing here commits.
 *
 * The worktree is left standing when the session ends, because the work in it
 * is mine and an unpushed commit lives nowhere else. Re-reviewing the result is
 * a new review run against the new head, never a continuation of the run that
 * produced these findings, so what was reviewed at which commit stays honest.
 */
export const fix = Command.make(
  "fix",
  { pr: prArgument },
  Effect.fn("fix")(
    function* ({ pr }) {
      const file: ConfigFile = Option.getOrElse(yield* readConfig, (): ConfigFile => ({}))
      const { number, repo } = yield* named(pr, Object.keys(file.repos ?? {}).toSorted())
      const settings = settingsFor(file, repo)

      const run = yield* currentRun(repo, number)
      const found = yield* whatItFound(run)
      yield* Console.log(`${repo}#${number}  ${run.head.slice(0, 7)}  ${summary(found, settings.stamp.blocks_on)}`)
      if (found.findings.length === 0) {
        return
      }

      const view = yield* prView(repo, number)
      yield* sameHead(number, run.head, view.headRefOid)

      const picked = yield* choose("Which findings does the session carry?", choicesOf(found.findings))
      const chosen = yield* noted(Option.getOrElse(picked, () => []))
      if (chosen.length === 0) {
        yield* Console.log("Nothing picked, so no session was opened.")
        return
      }

      const worktree = yield* fixWorktree(repo, number, view.headRefName)
      yield* Console.log(`  ${chosen.length} of ${found.findings.length} findings, on ${view.headRefName}`)
      yield* Console.log(`  ${worktree.directory}`)

      const ended = yield* fixSession({
        directory: worktree.directory,
        prompt: yield* promptFor({ repo, number, head: worktree.head, findings: chosen })
      })

      yield* Console.log(
        ended === 0
          ? `The session is over. Nothing was committed or pushed for you; the worktree stands at ${worktree.directory}.`
          : `The session ended with ${ended}. Nothing was committed or pushed for you; ` +
              `the worktree stands at ${worktree.directory}.`
      )
      yield* Console.log(`Once you have pushed, dw-mc review ${number} reviews the new head as a new run.`)
    },
    Effect.catchTag([...userFacing, "GitFailed", "RunnerFailed"], asUserError)
  )
).pipe(Command.withDescription("Pick findings from the current review run and open a fix session on them"))
