import { Effect, Option, Schema } from "effect"

import { prKey, storeFor } from "#adapters/store.ts"
import type { ChecksState } from "#domain/bucket.ts"
import { short } from "#domain/review.ts"

/** Everything the re-run guards are allowed to know about a pull request. */
export interface Situation {
  readonly repo: string
  readonly number: number
  /** The head every other fact here is about, and the one the cap is scoped to. */
  readonly head: string
  /** Whether I opened the pull request, which is the only kind whose CI is mine to re-run. */
  readonly mine: boolean
  readonly checks: ChecksState
  /** Why the classifier excuses this red CI, or null where it calls it mine to fix. */
  readonly flaky: string | null
  /** The head a re-run was already asked for at, or null where none has been. */
  readonly rerunAt: string | null
  /** The workflow runs behind the failing checks, which are what there is to re-run. */
  readonly runs: ReadonlyArray<string>
}

/**
 * Why this red CI is not one to re-run, or null where it is.
 *
 * This is the single place the re-run guards live. The order is what each
 * refusal is about rather than what it costs: whose pull request it is comes
 * first, because a pull request somebody else opened is none of this tool's
 * business whatever its CI says.
 *
 * The classifier's word is the guard that matters. A legitimate failure is
 * reported and never re-run - re-running it would hide the failure behind a
 * second identical one and cost me the minutes it takes.
 *
 * The cap is one re-run per head, and it is what keeps this from being a loop:
 * a job that was flaky once and fails again at the same code is a job that is
 * not flaky. It is scoped to the head, as a withdrawn stamp and a conflict
 * record are, so a branch that moved is a branch nothing has re-run yet.
 */
export const decide = (situation: Situation): string | null => {
  const where = `${situation.repo}#${situation.number}`
  if (!situation.mine) {
    return `${where} is not mine. dw-mc works on pull requests I author and on nothing else.`
  }
  if (situation.checks !== "red") {
    return `CI is not red on ${where}, so there is nothing to re-run.`
  }
  if (situation.flaky === null) {
    return (
      `CI is red on ${where} and nothing excuses it, so it is yours to fix. ` +
      `dw-mc reports a legitimate failure and never re-runs it.`
    )
  }
  if (situation.rerunAt === situation.head) {
    return (
      `${where} has already had its flaky CI re-run at ${short(situation.head)}. ` +
      `One re-run per head is the cap, so a job that fails twice is not flaky.`
    )
  }
  if (situation.runs.length === 0) {
    return (
      `Nothing red on ${where} is a workflow run dw-mc can re-run. ` +
      `A commit status is reported by whatever produced it, and re-running it is that thing's to do.`
    )
  }
  return null
}

/**
 * A re-run that has been asked for: the head it was asked for at.
 *
 * The head is the whole record, because the head is what the cap is scoped to.
 * A branch that moved has different code, a different CI run and a re-run of
 * its own to earn.
 */
export const Rerun = Schema.Struct({
  head: Schema.String
})
export type Rerun = typeof Rerun.Type

/**
 * The head a re-run was last asked for at on this pull request, or null where
 * none has been.
 *
 * A record this version cannot read is one another version of it wrote. Reading
 * it again as nothing costs a flaky pull request one extra re-run, where failing
 * here would cost the command outright.
 */
export const rerunFor = Effect.fn("rerun.rerunFor")(function* (repo: string, number: number) {
  const store = yield* storeFor("reruns", Rerun)
  const rerun = yield* Effect.orElseSucceed(store.get(prKey(repo, number)), () => Option.none<Rerun>())
  return Option.getOrNull(rerun)?.head ?? null
})

/** Writes down that a re-run was asked for at `head`, which is the only head it caps. */
export const recordRerun = Effect.fn("rerun.recordRerun")(function* (repo: string, number: number, head: string) {
  const store = yield* storeFor("reruns", Rerun)
  yield* store.set(prKey(repo, number), { head })
})
