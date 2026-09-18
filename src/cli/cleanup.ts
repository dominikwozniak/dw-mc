import { Console, Effect, Path } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import { prune } from "#adapters/git.ts"
import { beating } from "#adapters/heartbeat.ts"
import type { Paint } from "#adapters/paint.ts"
import { Paint as PaintService } from "#adapters/paint.ts"
import { confirm } from "#adapters/picker.ts"
import { discard, inventory, tidy } from "#adapters/store.ts"
import { table } from "#cli/table.ts"
import type { Plan } from "#domain/cleanup.ts"
import { empty, plan, weight } from "#domain/cleanup.ts"

export const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Do it without asking, for a machine that has no terminal to ask at")
)

/** A path said as the state directory's own, which is the heading it sits under. */
const inside = (path: Path.Path, state: string, directory: string): string => path.relative(state, directory)

/**
 * The two blocks a cleanup writes: what it takes and what it leaves.
 *
 * The weight is on every row because the whole question is whether this is
 * worth doing, and the reason is on every row because a clone and a worktree
 * are taken back for different reasons and both read as "a directory of mine"
 * on the screen.
 */
const lines = (it: Plan, state: string, path: Path.Path, paint: Paint): ReadonlyArray<string> => {
  const taking = table([
    ...it.worktrees.map((worktree) => [
      paint.dim(inside(path, state, worktree.directory)),
      weight(worktree.size),
      "a review worktree a run left behind"
    ]),
    ...it.clones.map((clone) => [
      paint.dim(inside(path, state, clone.directory)),
      weight(clone.size),
      "a bare clone, cloned again on the next run"
    ])
  ])

  const staying = table(
    it.kept.map((kept) => [paint.dim(inside(path, state, kept.clone.directory)), weight(kept.clone.size), kept.because])
  )

  return [
    "Takes back",
    ...taking.map((line) => `  ${line}`),
    "",
    ...(staying.length === 0 ? [] : ["Stays", ...staying.map((line) => `  ${line}`), ""])
  ]
}

/**
 * Takes back the disk the tool spent on itself, and nothing that is mine.
 *
 * What it removes is what the tool builds again by itself: the bare clones and
 * the worktrees a review run cut. What it never removes is what I decided - the
 * configuration file - and what I worked in - the worktree of a fix or resolve
 * session, which stands on a branch of the tool's own and holds what I
 * committed there. Forgetting a pull request's records is a different question
 * with a different answer (#58), and it is not asked here.
 *
 * A clone with a session standing on it stays with the session: a standing
 * worktree keeps its history inside the clone, so a clone taken from under one
 * would leave a directory of files with nothing behind them. The clones that
 * stay are pruned instead, because a worktree directory removed under `git`
 * leaves the clone's record of it behind and the next session cut at that path
 * is refused as already registered.
 */
export const cleanup = Command.make(
  "cleanup",
  { yes: yesFlag },
  Effect.fn("cleanup")(function* ({ yes }) {
    const path = yield* Path.Path
    const paint = yield* PaintService
    // The whole reason to run this is that the clones have grown large, and the
    // larger they are the longer the walk that weighs them. A blank screen that
    // gets blanker the more there is to take back is exactly backwards.
    const found = yield* beating(
      (since) => `measuring the state directory · ${since}`,
      () => inventory
    )
    const it = plan(found)

    if (empty(it)) {
      yield* Console.log(`Nothing to take back in ${found.directory}.`)
      return
    }

    yield* Effect.forEach(lines(it, found.directory, path, paint), (line) => Console.log(line))

    if (!yes && !(yield* confirm(`Take back ${weight(it.size)}?`))) {
      yield* Console.log("Nothing was removed.")
      return
    }

    yield* Effect.forEach([...it.worktrees, ...it.clones], (taken) =>
      Effect.andThen(discard(taken.directory), tidy(taken.directory, found.directory))
    )
    yield* Effect.forEach(it.kept, (kept) => prune(kept.clone.directory))

    yield* Console.log(`Took back ${weight(it.size)}.`)
  })
).pipe(Command.withDescription("Take back the disk the tool spent on clones and review worktrees"))
