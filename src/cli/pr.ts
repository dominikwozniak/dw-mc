import { Effect, Option } from "effect"
import { Argument, CliError } from "effect/unstable/cli"

import { launcherOf, readOrEmpty, registeredIn, settingsFor } from "#adapters/config.ts"
import { beating } from "#adapters/heartbeat.ts"
import { prKey, remembered, storeFor } from "#adapters/store.ts"
import { Facts } from "#domain/bucket.ts"
import type { Reference } from "#domain/reference.ts"
import { resolve } from "#domain/reference.ts"
import { lastRun } from "#domain/review.ts"

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
 * What a command that acts on one pull request opens with: which pull request
 * it is, and what the configuration says about its repository.
 *
 * Nine commands ask the file the same three questions before they do anything
 * else, and asking them here is what keeps the answers the same: which
 * repositories are registered decides what a bare `28` may name, and a command
 * that read the file its own way would resolve a different pull request from
 * the one beside it.
 *
 * `settings` and `launcher` come back whether or not this command wants them,
 * because both are a merge of records already in hand and neither reads
 * anything. The file itself does not, so nothing downstream keeps a copy of it.
 */
export const forPr = Effect.fn("pr.forPr")(function* (pr: string) {
  const file = yield* readOrEmpty
  const { number, repo } = yield* named(pr, registeredIn(file))
  return { repo, number, settings: settingsFor(file, repo), launcher: launcherOf(file) }
})

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
 * Facts that are missing and facts this version cannot read come to the same
 * sentence, because a sweep can write them again either way.
 */
export const swept = Effect.fn("pr.swept")(function* (repo: string, number: number) {
  const store = yield* storeFor("prs", Facts)
  const facts = yield* remembered(store.get(prKey(repo, number)))
  if (Option.isNone(facts)) {
    return yield* new CliError.UserError({
      cause: `Nothing is known about ${repo}#${number} yet. Run dw-mc sweep first.`
    })
  }
  return facts.value
})

/**
 * The review run whose findings are the current ones, or the sentence saying
 * there are none.
 *
 * The last run on the pull request is what "current" means here, and it is read
 * off the state directory rather than worked out from GitHub: the commands that
 * ask are ones I run inside a fix session, where another round trip to GitHub
 * buys nothing the run it is about to fix does not already say.
 */
export const currentRun = Effect.fn("pr.currentRun")(function* (repo: string, number: number) {
  const run = yield* lastRun(repo, number)
  if (Option.isNone(run)) {
    return yield* new CliError.UserError({
      cause: `No review run on ${repo}#${number}. Run dw-mc review ${number} first.`
    })
  }
  return run.value
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
