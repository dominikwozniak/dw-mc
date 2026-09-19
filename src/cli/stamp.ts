import { Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import { Paint } from "#adapters/paint.ts"
import { opener, print } from "#cli/block.ts"
import { asUserError } from "#cli/exit.ts"
import { forPr, prArgument, swept } from "#cli/pr.ts"
import { stampOf, withdraw } from "#domain/stamp.ts"

const withdrawFlag = Flag.Boolean("withdraw").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Take the stamp off this pull request, until its head changes")
)

/**
 * The stamp of one pull request, and the one way to take it off by hand.
 *
 * Printing it is the whole command without `--withdraw`: the mark is computed,
 * so what is worth reading is the reason, which is either what it rests on or
 * the first thing that withholds it.
 *
 * `--withdraw` is where I overrule the computation, and it takes the stamp off
 * the head the facts are about rather than whatever GitHub has moved on to
 * since: the stamp I am withdrawing is the one the table showed me, on code I
 * have read, so the withdrawal is pinned to exactly that head. A head that has
 * moved is a stamp the next sweep computes again anyway.
 *
 * Neither path reaches past this machine at all: the stamp is mine, it is
 * computed from what a sweep already wrote down, and nobody else ever sees it
 * (ADR 0001, ADR 0002).
 */
export const stampCommand = Command.make(
  "stamp",
  { pr: prArgument, withdraw: withdrawFlag },
  Effect.fn("stamp")(
    function* ({ pr, withdraw: byHand }) {
      const { number, repo } = yield* forPr(pr)

      const facts = yield* swept(repo, number)
      const paint = yield* Paint

      if (byHand) {
        yield* withdraw(repo, number, facts.head)
        yield* print([opener(paint, repo, number, facts.head, "stamp withdrawn, until the head changes")])
        return
      }

      const stamp = yield* stampOf(facts)
      yield* print([
        opener(paint, repo, number, facts.head, stamp.stamped ? "stamped" : `not stamped: ${stamp.reason}`)
      ])
    },
    Effect.catchTag(["ConfigMalformed"], asUserError)
  )
).pipe(Command.withDescription("Print my stamp on one pull request, or withdraw it by hand"))
