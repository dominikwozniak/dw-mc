import { Console, Effect, Option } from "effect"
import { CliError, Command, Flag } from "effect/unstable/cli"

import type { ConfigFile } from "#adapters/config.ts"
import { read as readConfig, settingsFor } from "#adapters/config.ts"
import { prView } from "#adapters/gh.ts"
import { fixWorktree } from "#adapters/git.ts"
import { choose, note } from "#adapters/picker.ts"
import { fixSession } from "#adapters/runner.ts"
import { currentRun, header, whatItFound } from "#cli/findings.ts"
import { named, prArgument } from "#cli/pr.ts"
import { asUserError, userFacing } from "#cli/sweep.ts"
import { table } from "#cli/table.ts"
import type { Finding } from "#domain/findings.ts"
import type { Chosen } from "#domain/fix.ts"
import { promptFor, staleAt } from "#domain/fix.ts"

const commitFlag = Flag.Boolean("commit").pipe(
  Flag.withDescription("Let this session commit what it changes, over what the repository configured"),
  Flag.optional
)

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

/** The domain's word on a head that has moved, as the command's own failure. */
const fixable = (number: number, run: string, now: string) => {
  const stale = staleAt(number, run, now)
  return stale === null ? Effect.void : Effect.fail(new CliError.UserError({ cause: stale }))
}

/**
 * A fix session: the findings I picked, in an agent session I steer.
 *
 * The tool fixes nothing. It picks the findings apart with me, cuts a worktree
 * on a branch of its own that tracks the pull request's, and hands the session
 * what I chose as JSON; then it is out of the way. I steer and I push. Nothing
 * here writes to GitHub, and the tool itself commits nothing: whether the
 * session may commit inside the worktree is `fix.commits`, or `--commit` for
 * one session.
 *
 * The worktree is left standing when the session ends, because the work in it
 * is mine and an unpushed commit lives nowhere else. Re-reviewing the result is
 * a new review run against the new head, never a continuation of the run that
 * produced these findings, so what was reviewed at which commit stays honest.
 */
export const fix = Command.make(
  "fix",
  { pr: prArgument, commit: commitFlag },
  Effect.fn("fix")(
    function* ({ commit, pr }) {
      const file: ConfigFile = Option.getOrElse(yield* readConfig, (): ConfigFile => ({}))
      const { number, repo } = yield* named(pr, Object.keys(file.repos ?? {}).toSorted())
      const settings = settingsFor(file, repo)

      const run = yield* currentRun(repo, number)
      const found = yield* whatItFound(run)
      yield* Console.log(header(run, found, settings.stamp.blocks_on))
      if (found.findings.length === 0) {
        return
      }

      const view = yield* prView(repo, number)
      yield* fixable(number, run.head, view.headRefOid)

      const picked = yield* choose("Which findings does the session carry?", choicesOf(found.findings))
      const chosen = yield* noted(Option.getOrElse(picked, () => []))
      if (chosen.length === 0) {
        yield* Console.log("Nothing picked, so no session was opened.")
        return
      }

      const commits = Option.getOrElse(commit, () => settings.fix.commits)
      const worktree = yield* fixWorktree(repo, number, view.headRefName)
      yield* Console.log(
        `  ${chosen.length} of ${found.findings.length} findings, ${commits ? "committing" : "not committing"}`
      )
      yield* Console.log(`  ${worktree.directory}, pushing to ${view.headRefName}`)

      const ended = yield* fixSession({
        directory: worktree.directory,
        prompt: yield* promptFor({ repo, number, head: worktree.head, findings: chosen }, commits)
      })

      yield* Console.log(ended === 0 ? "The session is over." : `The session ended with ${ended}.`)
      yield* Console.log(
        `${commits ? "Nothing was pushed" : "Nothing was committed or pushed"} for you; ` +
          `the worktree stands at ${worktree.directory}.`
      )
      yield* Console.log(`Once you have pushed, dw-mc review ${number} reviews the new head as a new run.`)
    },
    Effect.catchTag([...userFacing, "GitFailed", "WorktreeHeld", "RunnerFailed"], asUserError)
  )
).pipe(Command.withDescription("Pick findings from the current review run and open a fix session on them"))
