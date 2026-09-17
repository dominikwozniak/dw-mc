import { Effect, Option } from "effect"
import { Argument, CliError } from "effect/unstable/cli"

import { beating } from "#adapters/heartbeat.ts"
import { prKey, storeFor } from "#adapters/store.ts"
import { Facts } from "#domain/bucket.ts"
import type { Reference } from "#domain/reference.ts"
import { resolve } from "#domain/reference.ts"

/** The pull request a command acts on, named the way I actually type it. */
export const prArgument = Argument.String("pr").pipe(
  Argument.withDescription("The pull request, as 28 or owner/name#28")
)

/** What to say about a reference that named no one pull request. */
const whyNothingNamed = (reference: Exclude<Reference, { readonly _tag: "resolved" }>): string => {
  if (reference._tag === "unreadable") {
    return `'${reference.text}' is not a pull request. Name one as 28, or as owner/name#28.`
  }
  const example = `${reference.repos[0] ?? "owner/name"}#28`
  return reference.repos.length === 0
    ? `No repositories are registered, so a number alone names nothing. ` +
        `Run dw-mc init inside a repository, or name the pull request as ${example}.`
    : `${reference.repos.length} repositories are registered, so a number alone could be any of them. ` +
        `Name the pull request as ${example}.`
}

/** The pull request the argument names, or the sentence saying why it names none. */
export const named = (pr: string, registered: ReadonlyArray<string>) => {
  const reference = resolve(pr, registered)
  return reference._tag === "resolved"
    ? Effect.succeed(reference)
    : Effect.fail(new CliError.UserError({ cause: whyNothingNamed(reference) }))
}

/**
 * A domain guard's word, as the command's own failure.
 *
 * Every guard in the tool answers the same shape - the sentence saying why not,
 * or null - so turning that answer into a refusal is spelled once here rather
 * than beside each command that asks one.
 */
export const refuse = (why: string | null): Effect.Effect<void, CliError.UserError> =>
  why === null ? Effect.void : Effect.fail(new CliError.UserError({ cause: why }))

/**
 * What the last sweep learned about one pull request, or the sentence sending
 * me to a sweep.
 *
 * A command that reads these rather than GitHub says what the table said: the
 * stamp and the cutoff a conversation is measured against are both computed
 * from the facts a sweep wrote down, and asking GitHub again would make them a
 * different answer from the one `dw-mc status` printed.
 *
 * Facts this version cannot read are facts another version of them wrote, and a
 * sweep can write them again, so both cases say the same thing.
 */
export const swept = Effect.fn("pr.swept")(function* (repo: string, number: number) {
  const store = yield* storeFor("prs", Facts)
  const facts = yield* Effect.orElseSucceed(store.get(prKey(repo, number)), () => Option.none<Facts>())
  if (Option.isNone(facts)) {
    return yield* new CliError.UserError({
      cause: `Nothing is known about ${repo}#${number} yet. Run dw-mc sweep first.`
    })
  }
  return facts.value
})

/**
 * The guard reads of one command, under a heartbeat.
 *
 * Every command that acts on a pull request reads its guards live rather than
 * off the last sweep, because each of them is about the pull request as it is
 * now. That read is a second or two against GitHub before a word can be
 * printed, and it used to be spent on a blank screen.
 *
 * There is nothing to count here - two or three calls, and a number counting to
 * three says less than the words do - so the line is what is being read and how
 * long it has taken. It gives the heartbeat no aside, so a piped command prints
 * what it always printed.
 */
export const reading = <A, E, R>(where: string, read: Effect.Effect<A, E, R>) =>
  beating(
    (since) => `reading ${where} · ${since}`,
    () => read
  )
