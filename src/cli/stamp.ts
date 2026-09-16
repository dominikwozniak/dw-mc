import { Console, Effect, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import type { ConfigFile } from "#adapters/config.ts"
import { read as readConfig } from "#adapters/config.ts"
import { prView } from "#adapters/gh.ts"
import { storeFor } from "#adapters/store.ts"
import { named, prArgument } from "#cli/pr.ts"
import { asUserError, userFacing } from "#cli/sweep.ts"
import { Facts, factsKey } from "#domain/bucket.ts"
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
  const facts = yield* Effect.orElseSucceed(store.get(factsKey(repo, number)), () => Option.none<Facts>())
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
 * `--withdraw` is where I overrule the computation, on a head I have read, and
 * it asks GitHub for the head rather than trusting the last sweep's: a
 * withdrawal outlives nothing but the code it was made against, so pinning it
 * to a head the pull request has already moved off would withdraw nothing.
 *
 * Neither path writes a thing to GitHub. The stamp is mine, it lives on this
 * machine, and nobody else ever sees it (ADR 0001, ADR 0002).
 */
export const stampCommand = Command.make(
  "stamp",
  { pr: prArgument, withdraw: withdrawFlag },
  Effect.fn("stamp")(
    function* ({ pr, withdraw: byHand }) {
      const file: ConfigFile = Option.getOrElse(yield* readConfig, (): ConfigFile => ({}))
      const { number, repo } = yield* named(pr, Object.keys(file.repos ?? {}).toSorted())

      if (byHand) {
        const view = yield* prView(repo, number)
        yield* withdraw(repo, number, view.headRefOid)
        yield* Console.log(`${repo}#${number}  ${view.headRefOid.slice(0, 7)}  stamp withdrawn, until the head changes`)
        return
      }

      const facts = yield* sweptFacts(repo, number)
      const stamp = yield* stampOf(facts)
      yield* Console.log(
        `${repo}#${number}  ${facts.head.slice(0, 7)}  ${stamp.stamped ? "stamped" : `not stamped: ${stamp.reason}`}`
      )
    },
    Effect.catchTag(userFacing, asUserError)
  )
).pipe(Command.withDescription("Print my stamp on one pull request, or withdraw it by hand"))
