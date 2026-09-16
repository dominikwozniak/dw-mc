import { Effect, Option, Schema } from "effect"

import { storeFor } from "#adapters/store.ts"
import type { Facts } from "#domain/bucket.ts"
import { factsKey } from "#domain/bucket.ts"

/** My local mark that a tracked PR has passed my bar, and what it rests on. */
export interface Stamp {
  readonly stamped: boolean
  /** What the mark says, or the first thing that withholds it. */
  readonly reason: string
}

/**
 * A stamp I took off a pull request by hand, and the head I took it off at.
 *
 * The head is the whole record: a withdrawal is my overruling the computation
 * on code I have read, so it lasts exactly as long as that code is what the
 * pull request is.
 */
export const Withdrawal = Schema.Struct({ head: Schema.String })
export type Withdrawal = typeof Withdrawal.Type

/** Where a withdrawal is kept: one per pull request, because only the last one counts. */
export const withdrawalKey = (repo: string, number: number): string => `${repo}#${number}`

/** The stamp a pull request has not earned, and the first reason it has not. */
const withheld = (reason: string): Stamp => ({ stamped: false, reason })

/** What CI has to say before the stamp will rest on it, which is green and nothing else. */
const whyNotGreen: Record<Facts["checks"], string | null> = {
  green: null,
  red: "CI is red",
  pending: "CI is still running",
  none: "no CI ran on this head"
}

/** What GitHub has to say about merging, which is that it would. */
const whyNotMergeable: Record<Facts["mergeable"], string | null> = {
  mergeable: null,
  conflicting: "merge conflict",
  unknown: "GitHub has not said whether it merges"
}

/**
 * The stamp of one tracked PR: whether it has passed my bar, and why.
 *
 * The mark is computed rather than clicked, so it means the same thing every
 * time: a review run on this head that found nothing blocking, CI green as the
 * repository's `ci.ignore` defines green, and a pull request GitHub would
 * merge. A red CI the flaky classifier excused is still not green here - the
 * merge button is mine to press and that check is still red.
 *
 * Nothing about this rests on a previous stamp, which is what makes a head
 * change clear it: facts are about one head, and a run is recorded against one.
 *
 * A withdrawal comes first, because it is the one thing here I decided rather
 * than computed.
 */
export const stampFor = (facts: Facts, withdrawnAt: string | null): Stamp => {
  if (withdrawnAt === facts.head) {
    return withheld("withdrawn by hand")
  }
  if (facts.reviewRunHead !== facts.head) {
    return withheld("no review run on this head")
  }
  if (facts.blockingFindings > 0) {
    return withheld(`${facts.blockingFindings} blocking finding${facts.blockingFindings === 1 ? "" : "s"}`)
  }
  const ci = whyNotGreen[facts.checks]
  if (ci !== null) {
    return withheld(ci)
  }
  const merge = whyNotMergeable[facts.mergeable]
  if (merge !== null) {
    return withheld(merge)
  }
  return { stamped: true, reason: "a clean review run on this head, green CI, mergeable" }
}

/**
 * The head a stamp was withdrawn at, or null where none was.
 *
 * A withdrawal this version cannot read is one another version of this record
 * wrote, and a stamp is computed from everything else: forgetting it hands the
 * pull request back to the computation, where failing here would cost me the
 * command I asked for.
 */
export const withdrawnAt = Effect.fn("stamp.withdrawnAt")(function* (repo: string, number: number) {
  const store = yield* storeFor("stamps", Withdrawal)
  const withdrawal = yield* Effect.orElseSucceed(store.get(withdrawalKey(repo, number)), () =>
    Option.none<Withdrawal>()
  )
  return Option.match(withdrawal, { onNone: () => null, onSome: (it) => it.head })
})

/** Takes the stamp off a pull request at `head`, until its head changes. */
export const withdraw = Effect.fn("stamp.withdraw")(function* (repo: string, number: number, head: string) {
  const store = yield* storeFor("stamps", Withdrawal)
  yield* store.set(withdrawalKey(repo, number), { head })
})

/** The stamp of one tracked PR, with the withdrawal this machine holds against it. */
export const stampOf = Effect.fn("stamp.stampOf")(function* (facts: Facts) {
  return stampFor(facts, yield* withdrawnAt(facts.repo, facts.number))
})

/**
 * Which of these tracked PRs carry a stamp, keyed the way their facts are.
 *
 * A table asks the question of every row at once, and the withdrawals are the
 * only thing here that has to be read off the disk.
 */
export const stampedAmong = Effect.fn("stamp.stampedAmong")(function* (facts: ReadonlyArray<Facts>) {
  const marks = yield* Effect.forEach(facts, (it) =>
    Effect.map(stampOf(it), (stamp) => ({ key: factsKey(it.repo, it.number), stamped: stamp.stamped }))
  )
  return new Set(marks.filter((mark) => mark.stamped).map((mark) => mark.key))
})
