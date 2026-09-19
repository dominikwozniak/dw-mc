import { Console, Effect, Path } from "effect"
import { Command } from "effect/unstable/cli"

import { Paint } from "#adapters/paint.ts"
import { inventory, sessionBranch } from "#adapters/store.ts"
import { forPr, prArgument } from "#cli/pr.ts"
import { count, table } from "#cli/table.ts"
import { sessionName } from "#domain/cleanup.ts"
import { forget, standingOn } from "#domain/forget.ts"

/**
 * Forgets one pull request and says what stays: the records go, the session
 * worktrees standing on it do not.
 *
 * `deleted` is the branch the pull request stood on, where the caller has just
 * deleted it. A session there tracks a branch that is gone, which is worth
 * saying, and what it holds is still mine, so saying it is all this does.
 */
export const forgetting = Effect.fn("forgetting")(function* (
  repo: string,
  number: number,
  options: { readonly deleted?: string | undefined } = {}
) {
  const deleted = options.deleted
  const path = yield* Path.Path
  const paint = yield* Paint
  const where = `${repo}#${number}`

  const forgot = yield* forget(repo, number)
  yield* Console.log(forgot === 0 ? `Nothing is kept about ${where}.` : `Forgot ${where}: ${count(forgot, "record")}.`)

  const found = yield* inventory
  const sessions = standingOn(found, repo, number)
  if (sessions.length === 0) {
    return
  }

  const rows = table(
    sessions.map((it) => [
      paint.dim(path.relative(found.directory, it.directory)),
      `a ${sessionName(it.session)} session's worktree, on ${sessionBranch(it.session, number)}` +
        (deleted === undefined ? "" : `, which tracked ${deleted} - deleted with the merge`)
    ])
  )
  yield* Console.log("")
  yield* Console.log("Stays")
  yield* Effect.forEach(rows, (row) => Console.log(`  ${row}`))
  yield* Console.log("")
  yield* Console.log("What you committed there is yours, so nothing here takes it down.")
})

/**
 * Forgets a pull request that closed some other way than `dw-mc merge`.
 *
 * A sweep never does this on its own. A pull request missing from one search is
 * not one that is gone - a failed `gh search` would look the same - and a sweep
 * is built so that a failure costs a row rather than the table. Being done is
 * something I know and the tool does not, except when it merged the pull
 * request itself.
 */
export const forgetCommand = Command.make(
  "forget",
  { pr: prArgument },
  Effect.fn("forget")(function* ({ pr }) {
    const { number, repo } = yield* forPr(pr)
    yield* forgetting(repo, number)
  })
).pipe(Command.withDescription("Forget everything kept about a pull request that is done"))
