import type { DateTime } from "effect"
import { Console, Effect, Option } from "effect"
import { CliError, Command } from "effect/unstable/cli"
import type { KeyValueStore } from "effect/unstable/persistence"

import { rollupState } from "#adapters/ci.ts"
import type { ConfigFile, Settings } from "#adapters/config.ts"
import { read as readConfig, settingsFor } from "#adapters/config.ts"
import type { Comment, Found } from "#adapters/gh.ts"
import {
  mergeabilityOf,
  prComments,
  prCommits,
  prReviews,
  prView,
  reviewDecisionOf,
  searchPrs,
  viewer
} from "#adapters/gh.ts"
import { prKey, storeFor } from "#adapters/store.ts"
import { count } from "#cli/table.ts"
import type { Facts } from "#domain/bucket.ts"
import { Facts as FactsSchema } from "#domain/bucket.ts"
import { blocking } from "#domain/findings.ts"
import { classify, evidenceFor } from "#domain/flaky.ts"
import { newest } from "#domain/moment.ts"
import { isQuiet, pulseOf } from "#domain/quiet.ts"
import { conflictFor } from "#domain/rebase.ts"
import { reportedBy, ReviewRun, runKey } from "#domain/review.ts"

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
type Runs = KeyValueStore.SchemaStore<typeof ReviewRun>

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
const sweepPr = Effect.fn("sweep.pullRequest")(function* (
  store: Store,
  runs: Runs,
  me: string,
  found: Found,
  settings: Settings
) {
  const view = yield* prView(found.repo, found.number)
  const [onThePr, inReviews] = yield* Effect.all(
    [prComments(found.repo, found.number), prReviews(found.repo, found.number)],
    { concurrency: 2 }
  )
  const comments = [...onThePr, ...inReviews]

  const checks = rollupState(view.statusCheckRollup, settings.ci.ignore)
  const newestHumanCommentAt = newest(byHumansOtherThan(comments, me))

  const key = prKey(found.repo, found.number)
  // State this version cannot read is state from another version of these
  // facts, and these facts are a cache of GitHub: reading them again costs a
  // sweep some calls, where failing here would cost the PR its row for good.
  const previous = Option.getOrUndefined(yield* Effect.orElseSucceed(store.get(key), () => Option.none<Facts>()))
  // Whether this head has been reviewed is the run's to say, not a previous
  // sweep's: a run is recorded against one head, and a head with no run of its
  // own has not been reviewed however many sweeps have seen the pull request.
  // A run that could not report findings does not count, either: its verdict is
  // what takes a pull request out of Needs review run, and it reached none.
  const run = yield* Effect.orElseSucceed(runs.get(runKey(found.repo, found.number, view.headRefOid)), () =>
    Option.none<ReviewRun>()
  )
  const reported = Option.match(run, { onNone: () => null, onSome: reportedBy })
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

  // A red CI is classified once per state of the PR: while it sits where the
  // last sweep left it, the verdict it earned there still stands.
  const ciFlaky =
    checks !== "red"
      ? null
      : quiet !== undefined
        ? quiet.ciFlaky
        : yield* Effect.map(
            evidenceFor(found.repo, found.number, view.statusCheckRollup, settings.ci.ignore),
            (evidence) => {
              const verdict = classify(evidence, settings.ci.flaky_patterns)
              return verdict.classification === "flaky" ? verdict.reason : null
            }
          )

  const rebaseConflictAt = yield* Effect.map(conflictFor(found.repo, found.number), (it) => it?.head ?? null)

  const facts: Facts = {
    repo: found.repo,
    number: found.number,
    title: view.title,
    url: view.url,
    draft: view.isDraft,
    head: view.headRefOid,
    mergeable: mergeabilityOf(view.mergeable),
    reviewDecision: reviewDecisionOf(view.reviewDecision),
    checks,
    ciFlaky,
    rebaseConflictAt,
    newestHumanCommentAt,
    myLastCommentAt: newest(writtenBy(comments, me)),
    myLastCommitAt,
    reviewRunHead: reported === null ? null : view.headRefOid,
    blockingFindings: reported === null ? 0 : blocking(reported.findings, settings.stamp.blocks_on).length
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
  const runs = yield* storeFor("runs", ReviewRun)
  const me = yield* viewer

  const found = gather(yield* Effect.forEach(repos, (repo) => attempt(repo, searchPrs(repo)), { concurrency }))

  const swept = gather(
    yield* Effect.forEach(
      found.got,
      (pr: Found) =>
        attempt(
          `${pr.repo}#${pr.number}`,
          Effect.map(sweepPr(store, runs, me, pr, settingsFor(file, pr.repo)), (facts) => [facts])
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
