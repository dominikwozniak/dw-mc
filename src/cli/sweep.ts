import { Console, DateTime, Effect, Option } from "effect"
import { CliError, Command } from "effect/unstable/cli"
import type { KeyValueStore } from "effect/unstable/persistence"

import type { ConfigFile, Settings } from "#adapters/config.ts"
import { read as readConfig, settingsFor } from "#adapters/config.ts"
import type { Comment, Found } from "#adapters/gh.ts"
import {
  mergeabilityOf,
  prComments,
  prCommits,
  prView,
  reviewDecisionOf,
  rollupState,
  searchPrs,
  viewer
} from "#adapters/gh.ts"
import { storeFor } from "#adapters/store.ts"
import type { Facts } from "#domain/bucket.ts"
import { Facts as FactsSchema } from "#domain/bucket.ts"
import { isQuiet, pulseOf } from "#domain/quiet.ts"

/** Something a sweep could not read, and what GitHub said about it. */
export interface Trouble {
  readonly where: string
  readonly detail: string
}

/** What one pass over every tracked PR came back with. */
export interface Report {
  readonly repos: ReadonlyArray<string>
  readonly facts: ReadonlyArray<Facts>
  readonly troubles: ReadonlyArray<Trouble>
}

type Store = KeyValueStore.SchemaStore<typeof FactsSchema>

const newest = (moments: ReadonlyArray<DateTime.Utc>): DateTime.Utc | null =>
  moments.reduce<DateTime.Utc | null>(
    (best, at) => (best === null || DateTime.toEpochMillis(at) > DateTime.toEpochMillis(best) ? at : best),
    null
  )

const writtenBy = (comments: ReadonlyArray<Comment>, login: string): ReadonlyArray<DateTime.Utc> =>
  comments.filter((comment) => comment.login === login).map((comment) => comment.at)

const byHumansOtherThan = (comments: ReadonlyArray<Comment>, login: string): ReadonlyArray<DateTime.Utc> =>
  comments.filter((comment) => !comment.bot && comment.login !== login).map((comment) => comment.at)

/**
 * The facts about one tracked PR, read from GitHub and kept on disk.
 *
 * The cheap reads happen every time, because they are what says whether the PR
 * moved. The commits are asked for only when it did: `gh` returns every commit
 * message in full, and on a PR that is where the last sweep left it that whole
 * read buys a timestamp the state directory already has.
 */
const sweepPr = Effect.fn("sweep.pullRequest")(function* (store: Store, me: string, found: Found, settings: Settings) {
  const view = yield* prView(found.repo, found.number)
  const comments = yield* prComments(found.repo, found.number)

  const checks = rollupState(view.statusCheckRollup, settings.ci.ignore)
  const newestHumanCommentAt = newest(byHumansOtherThan(comments, me))

  const key = `${found.repo}#${found.number}`
  const previous = Option.getOrUndefined(yield* store.get(key))
  const quiet =
    previous !== undefined && isQuiet(pulseOf(previous), { head: view.headRefOid, checks, newestHumanCommentAt })
      ? previous
      : undefined

  const myLastCommitAt =
    quiet !== undefined
      ? quiet.myLastCommitAt
      : newest(
          (yield* prCommits(found.repo, found.number))
            .filter((commit) => commit.logins.includes(me))
            .map((commit) => commit.at)
        )

  const facts: Facts = {
    repo: found.repo,
    number: found.number,
    title: view.title,
    url: view.url,
    draft: view.isDraft,
    head: view.headRefOid,
    base: view.baseRefName,
    mergeable: mergeabilityOf(view.mergeable),
    reviewDecision: reviewDecisionOf(view.reviewDecision),
    checks,
    // Both wait on work this build order has not reached: the flaky classifier
    // and the first review run. Until then no PR is excused a red CI and every
    // PR is owed a review run, which is the behaviour the design asks for.
    ciFlaky: false,
    newestHumanCommentAt,
    myLastCommentAt: newest(writtenBy(comments, me)),
    myLastCommitAt,
    reviewRunHead: quiet?.reviewRunHead ?? null,
    blockingFindings: quiet?.blockingFindings ?? 0
  }

  yield* store.set(key, facts)
  return facts
})

type Attempt<A> = { readonly got: ReadonlyArray<A>; readonly troubles: ReadonlyArray<Trouble> }

/** A read that came back, or the trouble it came back with instead. */
const attempt = <A, E extends { readonly message: string }, R>(
  where: string,
  read: Effect.Effect<ReadonlyArray<A>, E, R>
): Effect.Effect<Attempt<A>, never, R> =>
  read.pipe(
    Effect.map((got): Attempt<A> => ({ got, troubles: [] })),
    Effect.catch((error) => Effect.succeed<Attempt<A>>({ got: [], troubles: [{ where, detail: error.message }] }))
  )

const gather = <A>(attempts: ReadonlyArray<Attempt<A>>): Attempt<A> => ({
  got: attempts.flatMap((it) => it.got),
  troubles: attempts.flatMap((it) => it.troubles)
})

/** How many reads of GitHub are in flight at once. */
const concurrency = 4

/**
 * One pass over every tracked PR, and nothing else: a sweep only ever reads.
 *
 * Every repository and every pull request is read on its own, so one of them
 * failing costs me its rows and leaves the rest of the table standing. What
 * failed comes back beside the facts rather than instead of them.
 */
export const sweep = Effect.gen(function* () {
  const file: ConfigFile = Option.getOrElse(yield* readConfig, (): ConfigFile => ({}))
  const repos = Object.keys(file.repos ?? {}).toSorted()
  if (repos.length === 0) {
    return { repos, facts: [], troubles: [] } satisfies Report
  }

  const store = yield* storeFor("prs", FactsSchema)
  const me = yield* viewer

  const found = gather(yield* Effect.forEach(repos, (repo) => attempt(repo, searchPrs(repo)), { concurrency }))

  const swept = gather(
    yield* Effect.forEach(
      found.got,
      (pr: Found) =>
        attempt(
          `${pr.repo}#${pr.number}`,
          Effect.map(sweepPr(store, me, pr, settingsFor(file, pr.repo)), (facts) => [facts])
        ),
      { concurrency }
    )
  )

  return {
    repos,
    facts: swept.got,
    troubles: [...found.troubles, ...swept.troubles]
  } satisfies Report
}).pipe(Effect.withSpan("sweep"))

/**
 * The failures a sweep can hit before it has a single row, which are the ones
 * worth a sentence: a machine or a file that needs fixing says what to fix
 * instead of printing a stack.
 */
export const userFacing = ["ConfigMalformed", "GhUnavailable", "GhReadFailed", "GhUnreadable"] as const

/** Turns one of those into the sentence the CLI prints. */
export const asUserError = (cause: unknown): Effect.Effect<never, CliError.UserError> =>
  Effect.fail(new CliError.UserError({ cause }))

/** What a sweep could not read, under a heading, so the table above it stands alone. */
export const printTroubles = Effect.fn("sweep.printTroubles")(function* (troubles: ReadonlyArray<Trouble>) {
  if (troubles.length === 0) {
    return
  }
  yield* Console.log("")
  yield* Console.log("Could not load")
  for (const trouble of troubles) {
    yield* Console.log(`  ${trouble.where}  ${trouble.detail}`)
  }
})

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`

/**
 * Refreshes what mission control knows about every tracked PR.
 *
 * `dw-mc status` does this too, so this command is for the pass on its own:
 * warming the state directory, or seeing what GitHub would not answer.
 */
export const sweepCommand = Command.make(
  "sweep",
  {},
  Effect.fn("sweep.command")(
    function* () {
      const report = yield* sweep
      yield* Console.log(
        report.repos.length === 0
          ? "No repositories registered. Run dw-mc init inside a repository to register it."
          : `Swept ${count(report.facts.length, "pull request")} across ${report.repos.length === 1 ? "1 repository" : `${report.repos.length} repositories`}`
      )
      yield* printTroubles(report.troubles)
    },
    Effect.catchTag(userFacing, asUserError)
  )
).pipe(Command.withDescription("Refresh what mission control knows about every tracked pull request"))
