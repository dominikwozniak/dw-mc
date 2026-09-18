import type { DateTime } from "effect"
import { Console, Effect, Option } from "effect"
import { CliError, Command, Flag } from "effect/unstable/cli"
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
  currentRepo,
  searchPrs,
  viewer
} from "#adapters/gh.ts"
import type { Reads } from "#adapters/heartbeat.ts"
import { beating } from "#adapters/heartbeat.ts"
import { prKey, remembered, storeFor } from "#adapters/store.ts"
import { asUserError, userFacing } from "#cli/exit.ts"
import { count } from "#cli/table.ts"
import { acknowledgedAt } from "#domain/acknowledgement.ts"
import type { Facts } from "#domain/bucket.ts"
import { Facts as FactsSchema } from "#domain/bucket.ts"
import type { Asked } from "#domain/coverage.ts"
import { asksWhereIAm, covered } from "#domain/coverage.ts"
import { flakyReason } from "#domain/flaky.ts"
import { newest } from "#domain/moment.ts"
import { isQuiet, pulseOf } from "#domain/quiet.ts"
import { conflictFor } from "#domain/rebase.ts"
import { reviewedAt } from "#domain/review.ts"

/** Something a sweep could not read, and what GitHub said about it. */
export interface Trouble {
  readonly where: string
  readonly detail: string
}

/** What one pass over the tracked PRs of the repositories it covered came back with. */
export interface Report {
  readonly repos: ReadonlyArray<string>
  /** How many registered repositories the pass left out, which a narrowed table owes me a word about. */
  readonly leftOut: number
  readonly facts: ReadonlyArray<Facts>
  readonly troubles: ReadonlyArray<Trouble>
}

/** What the picker asks a sweep for: every registered repository, wherever I stand. */
export const everything: Asked = { repo: undefined, all: true }

/** The repository I stand in, or none where the working directory is not one. */
const whereIAm = currentRepo.pipe(
  Effect.asSome,
  Effect.catchTag("NoRepository", () => Effect.succeedNone),
  Effect.map(Option.getOrUndefined)
)

type Store = KeyValueStore.SchemaStore<typeof FactsSchema>

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
  const [onThePr, inReviews] = yield* Effect.all(
    [prComments(found.repo, found.number), prReviews(found.repo, found.number)],
    { concurrency: 2 }
  )
  const comments = [...onThePr, ...inReviews]

  const checks = rollupState(view.statusCheckRollup, settings.ci.ignore)
  const newestHumanCommentAt = newest(byHumansOtherThan(comments, me))

  const key = prKey(found.repo, found.number)
  // Forgetting these costs a sweep the calls to read them again, where failing
  // here would cost the PR its row for good.
  const previous = Option.getOrUndefined(yield* remembered(store.get(key)))
  const reviewed = yield* reviewedAt(found.repo, found.number, view.headRefOid, settings.stamp.blocks_on)
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
        : yield* flakyReason(
            found.repo,
            found.number,
            view.statusCheckRollup,
            settings.ci.ignore,
            settings.ci.flaky_patterns
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
    // Read every time, like the conflict record: it is mine and written between
    // sweeps, so a quiet PR's previous facts know nothing of it.
    acknowledgedAt: yield* acknowledgedAt(found.repo, found.number),
    ...reviewed
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
 * How far a sweep has got, which is what the heartbeat of a sweep counts.
 *
 * The two stages are told apart because the second has a total the first cannot
 * know: how many pull requests there are to read is what the searches answer,
 * so counting towards it before they come back would count towards a number
 * made up.
 */
export type Swept =
  | { readonly _tag: "searching"; readonly done: number; readonly of: number }
  | { readonly _tag: "reading"; readonly done: number; readonly of: number }

/** `n` repositories, which `count` cannot say: the plural is not the noun plus s. */
const repositories = (n: number): string => (n === 1 ? "1 repository" : `${n} repositories`)

/** How the heartbeat of a sweep reads, wherever a command turns one. */
const saying =
  (swept: Swept): Reads =>
  (since) =>
    [
      "sweeping",
      swept._tag === "searching"
        ? `${swept.done} of ${repositories(swept.of)}`
        : `${swept.done} of ${count(swept.of, "pull request")}`,
      since
    ].join(" · ")

/**
 * One pass over the tracked PRs of the repositories `asked` covers, and nothing
 * else: a sweep only ever reads.
 *
 * Every repository and every pull request is read on its own, so one of them
 * failing costs me its rows and leaves the rest of the table standing. What
 * failed comes back beside the facts rather than instead of them.
 *
 * `report` is told how far the pass has got, every time it gets further. What
 * that is worth saying is the caller's, which is why it is handed a count and
 * not a sentence.
 */
export const sweep = Effect.fn("sweep")(function* (asked: Asked, report: (swept: Swept) => Effect.Effect<void>) {
  const file: ConfigFile = Option.getOrElse(yield* readConfig, (): ConfigFile => ({}))
  const registered = Object.keys(file.repos ?? {}).toSorted()
  const coverage = covered(asked, asksWhereIAm(asked, registered) ? yield* whereIAm : undefined, registered)
  if (coverage._tag === "refused") {
    return yield* new CliError.UserError({ cause: coverage.why })
  }
  const { repos, leftOut } = coverage
  if (repos.length === 0) {
    return { repos, leftOut, facts: [], troubles: [] } satisfies Report
  }

  const store = yield* storeFor("prs", FactsSchema)
  const me = yield* viewer

  let searched = 0
  yield* report({ _tag: "searching", done: 0, of: repos.length })
  const found = gather(
    yield* Effect.forEach(
      repos,
      (repo) =>
        Effect.tap(attempt(repo, searchPrs(repo)), () => {
          searched = searched + 1
          return report({ _tag: "searching", done: searched, of: repos.length })
        }),
      { concurrency }
    )
  )

  let read = 0
  yield* report({ _tag: "reading", done: 0, of: found.got.length })
  const swept = gather(
    yield* Effect.forEach(
      found.got,
      (pr: Found) =>
        Effect.tap(
          attempt(
            `${pr.repo}#${pr.number}`,
            Effect.map(sweepPr(store, me, pr, settingsFor(file, pr.repo)), (facts) => [facts])
          ),
          () => {
            read = read + 1
            return report({ _tag: "reading", done: read, of: found.got.length })
          }
        ),
      { concurrency }
    )
  )

  return {
    repos,
    leftOut,
    facts: swept.got,
    troubles: [...found.troubles, ...swept.troubles]
  } satisfies Report
})

/**
 * A sweep under its heartbeat, which is how every command that sweeps runs one.
 *
 * The three of them want the same line, so they say it once here rather than
 * three times over. It gives the heartbeat no aside, so a piped `dw-mc status`
 * prints exactly what it printed before there was a heartbeat at all.
 */
export const sweeping = (asked: Asked) =>
  beating(
    // Before the config is read there is no total to count towards, and a zero
    // there would be a number the sweep has not earned yet.
    (since) => `sweeping · ${since}`,
    (says) => sweep(asked, (swept) => says(saying(swept)))
  )

/** `--repo`, for a command that sweeps: the one registered repository to cover. */
export const repoFlag = Flag.String("repo").pipe(
  Flag.withDescription("Cover this registered repository only, as owner/name, wherever I stand"),
  Flag.optional
)

/** `--all`, for a command that sweeps: every registered repository, even from inside one. */
export const allFlag = Flag.Boolean("all").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Cover every registered repository, and not only the one I stand in")
)

/** What the two flags ask a sweep to cover. */
export const askedOf = (flags: { readonly repo: Option.Option<string>; readonly all: boolean }): Asked => ({
  repo: Option.getOrUndefined(flags.repo),
  all: flags.all
})

/**
 * The word a narrowed report owes me about what it left out, so a table of one
 * repository is not read as the whole picture.
 */
export const printLeftOut = Effect.fn("sweep.printLeftOut")(function* (report: Report) {
  if (report.leftOut === 0) {
    return
  }
  yield* Console.log("")
  yield* Console.log(
    `Only ${report.repos.join(", ")}. --all covers all ${report.repos.length + report.leftOut} registered repositories.`
  )
})

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
 * Refreshes what mission control knows about the tracked PRs it covers.
 *
 * `dw-mc status` does this too, so this command is for the pass on its own:
 * warming the state directory, or seeing what GitHub would not answer.
 */
export const sweepCommand = Command.make(
  "sweep",
  { repo: repoFlag, all: allFlag },
  Effect.fn("sweep.command")(
    function* (flags) {
      const report = yield* sweeping(askedOf(flags))
      yield* Console.log(
        report.repos.length === 0
          ? "No repositories registered. Run dw-mc init inside a repository to register it."
          : `Swept ${count(report.facts.length, "pull request")} across ${repositories(report.repos.length)}`
      )
      yield* printLeftOut(report)
      yield* printTroubles(report.troubles)
    },
    Effect.catchTag(userFacing, asUserError)
  )
).pipe(
  Command.withDescription(
    "Refresh what mission control knows about the tracked pull requests of the repository I stand in, or of every one"
  )
)
