import { Effect, Option, Schema } from "effect"

import { prKey, storeFor } from "#adapters/store.ts"
import type { ChecksState } from "#domain/bucket.ts"

/** One open pull request as a stack is read from: the branch it stands on and the one it merges into. */
export interface Branches {
  readonly number: number
  readonly head: string
  readonly base: string
}

/** Where a pull request sits among the pull requests built on each other. */
export interface Position {
  readonly position: number
  readonly length: number
}

/**
 * How many pull requests this one stands on.
 *
 * A branch is walked to what it merges into and on from there, however deep the
 * stack goes. Every pull request the walk has already counted is left alone,
 * which is what keeps two branches that merge into each other from being walked
 * around forever.
 */
const ancestorsOf = (pr: Branches, open: ReadonlyArray<Branches>, seen: Set<number>): number => {
  let count = 0
  let current = pr
  for (;;) {
    const parent = open.find((it) => it.head === current.base && !seen.has(it.number))
    if (parent === undefined) {
      return count
    }
    seen.add(parent.number)
    count += 1
    current = parent
  }
}

/**
 * How deep the stack goes above this pull request.
 *
 * Two branches cut from the same one are not two stacks deep, they are two
 * branches, so what counts is the deepest single line of them rather than how
 * many pull requests stand above it in total.
 */
const descendantsOf = (pr: Branches, open: ReadonlyArray<Branches>, seen: Set<number>): number => {
  let deepest = 0
  for (const child of open.filter((it) => it.base === pr.head && !seen.has(it.number))) {
    seen.add(child.number)
    deepest = Math.max(deepest, 1 + descendantsOf(child, open, seen))
  }
  return deepest
}

/**
 * Where a pull request sits in its stack, or null where it is in none.
 *
 * A stack is read off the branches alone: a pull request that merges into
 * another pull request's branch, or that another one merges into, is part of
 * one. The tool does not understand stacks and never drives them, so this
 * exists to recognise one and say where the pull request sits in it.
 */
export const stackOf = (number: number, open: ReadonlyArray<Branches>): Position | null => {
  const pr = open.find((it) => it.number === number)
  if (pr === undefined) {
    return null
  }
  const seen = new Set([number])
  const below = ancestorsOf(pr, open, seen)
  const above = descendantsOf(pr, open, seen)
  return below === 0 && above === 0 ? null : { position: below + 1, length: below + above + 1 }
}

/** What every guard about the branch itself reads, whatever is about to be done to it. */
export interface Branch {
  readonly repo: string
  readonly number: number
  /** Whether I opened the pull request, which is the only kind whose branch is mine to push. */
  readonly mine: boolean
  /** Whether the head branch lives in a fork rather than in the repository that was read. */
  readonly fromFork: boolean
  /** Whether the pull request was among the open ones the stack was read from. */
  readonly listed: boolean
  readonly stack: Position | null
}

/**
 * Why this branch is nobody's to touch here, or null where it is mine.
 *
 * These are the guards about the branch rather than about what is done to it,
 * which is why they are their own and why they say nothing about pushing: who
 * authored the pull request and where its branch lives is the boundary itself -
 * a branch somebody else authored and a branch in a fork are not mine to work
 * on, whatever else is true of them and whichever command asks. A stack comes
 * next, and a pull request the stack was not read from counts as one, because a
 * stack the tool cannot see is one it could drive: the tool does not understand
 * stacks, so the one thing it has to say about one is where the pull request
 * sits in it.
 */
export const boundary = (branch: Branch): string | null => {
  const where = `${branch.repo}#${branch.number}`
  if (!branch.mine) {
    return `${where} is not mine. dw-mc works on branches I author and on nothing else.`
  }
  if (branch.fromFork) {
    return (
      `${where} is opened from a fork, so its branch is not in ${branch.repo}. ` +
      `dw-mc works only on a branch in the repository it read.`
    )
  }
  if (!branch.listed) {
    return (
      `${where} was not among the open pull requests of ${branch.repo}, so nothing here can say whether ` +
      `it is in a stack. Read it again before touching the branch.`
    )
  }
  if (branch.stack !== null) {
    return (
      `${where} is ${branch.stack.position} of ${branch.stack.length} in a stack. ` +
      `dw-mc does not understand stacks and will not drive one; rebase it with whatever built the stack.`
    )
  }
  return null
}

/** Everything the rebase guards are allowed to know about a pull request. */
export interface Situation extends Branch {
  /** The branch the pull request merges into, which is what it would be rebased onto. */
  readonly base: string
  readonly enabled: boolean
  readonly checks: ChecksState
}

/**
 * Why this branch is not one to rebase, or null where it is.
 *
 * This is the single place the guards live, and they matter more than the
 * rebase itself: a force push is the one write the tool makes that can lose
 * work, and every rule here is about it never being a surprise.
 *
 * Being off is said first, because a repository that has not turned rebase on
 * has decided the question and nothing else about the pull request changes it.
 * The branch's own guards come next. CI is last and costs the most to get
 * wrong - rebasing while a run is in flight cancels the run I am waiting on,
 * and a red build is mine to fix where it is.
 */
export const decide = (situation: Situation): string | null => {
  const where = `${situation.repo}#${situation.number}`
  if (!situation.enabled) {
    return (
      `Rebase is off for ${situation.repo}. Set rebase.enabled: true for it in the config to turn it on, ` +
      `so a force push is never a surprise.`
    )
  }
  const refused = boundary(situation)
  if (refused !== null) {
    return refused
  }
  if (situation.checks === "pending") {
    return `CI is still running on ${where}. A rebase now would cancel the run you are waiting on.`
  }
  if (situation.checks === "red") {
    return `CI is red on ${where}, which is yours to fix before the branch moves.`
  }
  return null
}

/**
 * A rebase that conflicted: the head it conflicted at and the files it stopped
 * on.
 *
 * The head is what the record is scoped to, as it is for a withdrawn stamp: a
 * conflict is about the code the branch is at, so it lasts exactly as long as
 * that code is what the pull request is. A branch that moved is a branch
 * nothing here has tried to rebase yet.
 *
 * The paths are what makes the conflict something to open: `a rebase
 * conflicted` cannot tell a stale lockfile from half the pull request. They are
 * an optional key rather than a required one so a record an older version wrote
 * still reads, and a conflict with no paths still puts the pull request in
 * Needs me.
 */
export const Conflict = Schema.Struct({
  head: Schema.String,
  paths: Schema.optionalKey(Schema.Array(Schema.String))
})
export type Conflict = typeof Conflict.Type

/**
 * The conflict a rebase last left on this pull request, or null where it left
 * none.
 *
 * A record this version cannot read is one another version of it wrote, and a
 * conflict is worth a bucket rather than a failed sweep: forgetting it costs
 * the pull request one reason to be in Needs me, where failing here would cost
 * me the whole table.
 */
export const conflictFor = Effect.fn("rebase.conflictFor")(function* (repo: string, number: number) {
  const store = yield* storeFor("rebases", Conflict)
  const conflict = yield* Effect.orElseSucceed(store.get(prKey(repo, number)), () => Option.none<Conflict>())
  return Option.getOrNull(conflict)
})

/** Writes down that a rebase of `head` conflicted on `paths`, which is the only head it holds for. */
export const recordConflict = Effect.fn("rebase.recordConflict")(function* (
  repo: string,
  number: number,
  head: string,
  paths: ReadonlyArray<string>
) {
  const store = yield* storeFor("rebases", Conflict)
  yield* store.set(prKey(repo, number), { head, paths })
})
