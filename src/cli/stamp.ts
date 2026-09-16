import { Console, Effect, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import type { ConfigFile } from "#adapters/config.ts"
import { read as readConfig } from "#adapters/config.ts"
import { prKey, storeFor } from "#adapters/store.ts"
import { named, prArgument } from "#cli/pr.ts"
import { asUserError } from "#cli/sweep.ts"
import { Facts } from "#domain/bucket.ts"
import { stampOf, withdraw } from "#domain/stamp.ts"

const withdrawFlag = Flag.Boolean("withdraw").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Take the stamp off this pull request, until its head changes")
)

/**
 * What the last sweep learned about one pull request, or the sentence sending
 * me to a sweep.
 *
 * The stamp is computed from the facts a sweep wrote down, so this command
 * reads them rather than GitHub: a mark that asked GitHub again would be a
 * different mark from the one `dw-mc status` prints.
 *
 * Facts this version cannot read are facts another version of them wrote, and a
 * sweep can write them again, so both cases say the same thing.
 */
const sweptFacts = Effect.fn("stamp.sweptFacts")(function* (repo: string, number: number) {
  const store = yield* storeFor("prs", Facts)
  const facts = yield* Effect.orElseSucceed(store.get(prKey(repo, number)), () => Option.none<Facts>())
  if (Option.isNone(facts)) {
    return yield* asUserError(`Nothing is known about ${repo}#${number} yet. Run dw-mc sweep first.`)
  }
  return facts.value
})

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
      const file: ConfigFile = Option.getOrElse(yield* readConfig, (): ConfigFile => ({}))
      const { number, repo } = yield* named(pr, Object.keys(file.repos ?? {}).toSorted())

      const facts = yield* sweptFacts(repo, number)
      const where = `${repo}#${number}  ${facts.head.slice(0, 7)}`

      if (byHand) {
        yield* withdraw(repo, number, facts.head)
        yield* Console.log(`${where}  stamp withdrawn, until the head changes`)
        return
      }

      const stamp = yield* stampOf(facts)
      yield* Console.log(`${where}  ${stamp.stamped ? "stamped" : `not stamped: ${stamp.reason}`}`)
    },
    Effect.catchTag(["ConfigMalformed"], asUserError)
  )
).pipe(Command.withDescription("Print my stamp on one pull request, or withdraw it by hand"))
