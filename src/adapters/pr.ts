import { Effect, Match, Schema } from "effect"
import type { DateTime } from "effect"

import { CheckEntry } from "#adapters/ci.ts"
import { failedAs, readJson } from "#adapters/gh.ts"
import { capture } from "#adapters/spawner.ts"
import type { Mergeability, ReviewDecision } from "#terms/pr.ts"

/**
 * What GitHub says about a pull request itself: which ones are open, its head
 * and what merging it would take, its commits and what moved between two of
 * them, and the one write that lands it. Its checks are `ci.ts`'s and its
 * conversation is `conversation.ts`'s.
 */

const SearchResults = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      number: Schema.Int,
      repository: Schema.Struct({ nameWithOwner: Schema.String })
    })
  )
)

/** One open pull request the search found. */
export interface Found {
  readonly repo: string
  readonly number: number
}

/**
 * The open pull requests I authored in `repo`.
 *
 * One search per repository rather than one for all of them: a repository `gh`
 * cannot read then costs me that repository's rows and not the whole table.
 */
export const searchPrs = Effect.fnUntraced(function* (repo: string) {
  const found = yield* readJson(
    "search prs",
    "gh",
    ["search", "prs", "--author=@me", "--state=open", "--repo", repo, "--limit", "100", "--json", "number,repository"],
    SearchResults
  )

  return found.map((it): Found => ({ repo: it.repository.nameWithOwner, number: it.number }))
})

const PrView = Schema.fromJsonString(
  Schema.Struct({
    number: Schema.Int,
    title: Schema.String,
    url: Schema.String,
    isDraft: Schema.Boolean,
    headRefOid: Schema.String,
    headRefName: Schema.String,
    baseRefName: Schema.String,
    /** Who opened it, which is what says whether its branch is mine to push to. */
    author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
    /** Whether the head branch lives in a fork rather than in this repository. */
    isCrossRepository: Schema.Boolean,
    mergeable: Schema.String,
    reviewDecision: Schema.String,
    statusCheckRollup: Schema.NullOr(Schema.Array(CheckEntry)),
    /** What the review label is reconciled against: the labels it carries now, whoever put them there. */
    labels: Schema.Array(Schema.Struct({ name: Schema.String }))
  })
)
export type PrView = typeof PrView.Type

/**
 * The fields one `gh pr view` asks for, named so a test can spell the vector it
 * expects without copying the list and watching it drift.
 */
export const viewFields: string =
  "number,title,url,isDraft,headRefOid,headRefName,baseRefName,author,isCrossRepository,mergeable," +
  "reviewDecision,statusCheckRollup,labels"

/**
 * Everything about one pull request that arrives without paging through it:
 * its head, what GitHub thinks of merging it, and where CI got to.
 */
export const prView = Effect.fnUntraced(function* (repo: string, number: number) {
  return yield* readJson("pr view", "gh", ["pr", "view", String(number), "--repo", repo, "--json", viewFields], PrView)
})

const OpenPrs = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      number: Schema.Int,
      headRefName: Schema.String,
      baseRefName: Schema.String
    })
  )
)

/** One open pull request, as the branch it stands on and the one it merges into. */
export interface OpenPr {
  readonly number: number
  readonly head: string
  readonly base: string
}

/**
 * Every open pull request on a repository, by branch.
 *
 * Everyone's and not only mine: a stack is recognised from branches built on
 * branches, and a pull request of mine can sit on one somebody else opened.
 *
 * The page is deep because a pull request this misses is one that looks like it
 * is in no stack, and a stack the tool cannot see is one it could drive.
 */
export const openPrs = Effect.fnUntraced(function* (repo: string) {
  const open = yield* readJson(
    "pr list",
    "gh",
    ["pr", "list", "--repo", repo, "--state", "open", "--limit", "500", "--json", "number,headRefName,baseRefName"],
    OpenPrs
  )

  return open.map((it): OpenPr => ({ number: it.number, head: it.headRefName, base: it.baseRefName }))
})

const Compare = Schema.fromJsonString(
  Schema.Struct({ files: Schema.optionalKey(Schema.Array(Schema.Struct({ filename: Schema.String }))) })
)

/**
 * The repository paths that changed between two commits.
 *
 * GitHub compares them rather than git, because the commit a run was recorded
 * against is not one the tool's own clone is promised to still have: a force
 * push moves the pull request's ref and the old commit goes with it, where
 * GitHub keeps both sides of the comparison. A comparison of a commit with
 * itself reports no files at all, and so does one of two commits with nothing
 * between them, which is why the key is optional.
 *
 * `base...head` measures from where the two commits last agreed, so two heads
 * on one branch report what was pushed between them, and a branch rebased since
 * reports its whole diff. The second is the right answer for a caller deciding
 * whether the code has moved: after a rebase it has, all of it.
 */
export const comparedFiles = Effect.fnUntraced(function* (repo: string, base: string, head: string) {
  const compare = yield* readJson("api compare", "gh", ["api", `repos/${repo}/compare/${base}...${head}`], Compare)
  return (compare.files ?? []).map((file) => file.filename)
})

const Commits = Schema.fromJsonString(
  Schema.Struct({
    commits: Schema.Array(
      Schema.Struct({
        committedDate: Schema.DateTimeUtcFromString,
        authors: Schema.Array(Schema.Struct({ login: Schema.NullOr(Schema.String) }))
      })
    )
  })
)

/** One commit on a pull request, and who wrote it. */
export interface Commit {
  readonly logins: ReadonlyArray<string>
  readonly at: DateTime.Utc
}

/**
 * The commits on a pull request.
 *
 * This is the expensive read of the three: `gh` returns every commit with its
 * whole message, so a sweep only asks for it when something about the PR has
 * actually moved.
 */
export const prCommits = Effect.fnUntraced(function* (repo: string, number: number) {
  const view = yield* readJson(
    "pr view commits",
    "gh",
    ["pr", "view", String(number), "--repo", repo, "--json", "commits"],
    Commits
  )

  return view.commits.map((commit): Commit => ({
    logins: commit.authors.flatMap((author) => (author.login === null ? [] : [author.login])),
    at: commit.committedDate
  }))
})

/**
 * What `gh` says about merging, in our words. Anything else is `unknown`:
 * GitHub answers that too, for a PR whose mergeability it is still computing.
 *
 * `Match.withReturnType` comes first in the pipeline or the return type is not
 * enforced: a handler's literal widens to `string` on its own.
 */
export const mergeabilityOf = (raw: string): Mergeability =>
  Match.value(raw).pipe(
    Match.withReturnType<Mergeability>(),
    Match.when("MERGEABLE", () => "mergeable"),
    Match.when("CONFLICTING", () => "conflicting"),
    Match.orElse(() => "unknown")
  )

/**
 * What `gh` says the reviewers decided, in our words. A repository that requires
 * no reviewer reports an empty string, which is `none` rather than pending.
 */
export const reviewDecisionOf = (raw: string): ReviewDecision =>
  Match.value(raw).pipe(
    Match.withReturnType<ReviewDecision>(),
    Match.when("APPROVED", () => "approved"),
    Match.when("CHANGES_REQUESTED", () => "changes-requested"),
    Match.when("REVIEW_REQUIRED", () => "review-required"),
    Match.orElse(() => "none")
  )

/**
 * Squash-merges a pull request and deletes the branch it stood on.
 *
 * The one write the tool makes that no reflog of mine undoes, and the whole of
 * it: a squash, because that is how the repository lands a pull request and the
 * squash subject is its title, and the branch, because squashing kills it
 * anyway. No `--auto`, which would hand GitHub a merge to make at a head
 * nothing here has read (ADR 0008).
 *
 * Whether this pull request is one to merge is decided before we get here, and
 * `gh` still has the last word: a branch protection this machine cannot see
 * comes back as a failure and is printed as one.
 */
export const mergePr = Effect.fnUntraced(function* (repo: string, number: number) {
  yield* capture("gh", ["pr", "merge", String(number), "--repo", repo, "--squash", "--delete-branch"]).pipe(
    failedAs("pr merge")
  )
})

/**
 * As much of one pull request as a test cares to say, which is less than `gh`
 * answers about it.
 *
 * Every field it leaves out gets the answer a pull request nothing is wrong
 * with would give, so a test names only what its own question turns on.
 */
export interface PrFixture {
  readonly number: number
  readonly title?: string | undefined
  readonly isDraft?: boolean | undefined
  readonly headRefOid?: string | undefined
  readonly headRefName?: string | undefined
  readonly baseRefName?: string | undefined
  readonly author?: string | undefined
  readonly isCrossRepository?: boolean | undefined
  readonly mergeable?: string | undefined
  readonly reviewDecision?: string | undefined
  readonly statusCheckRollup?: ReadonlyArray<Record<string, unknown>> | null | undefined
  readonly labels?: ReadonlyArray<string> | undefined
}

/**
 * What `gh pr view --json <viewFields>` answers with about `pr`, for a fake
 * `gh`.
 *
 * It is written here rather than in each test because it is the shape `PrView`
 * parses: a field added to the read has one fixture to grow, and a test that
 * spelled its own would go on passing against a pull request `gh` no longer
 * describes that way.
 */
export const prViewOf = (repo: string, pr: PrFixture): Record<string, unknown> => ({
  number: pr.number,
  title: pr.title ?? "feat: a pull request",
  url: `https://github.com/${repo}/pull/${pr.number}`,
  isDraft: pr.isDraft ?? false,
  headRefOid: pr.headRefOid ?? "31268022360852f71815404b6bbdd6bd797cfb4c",
  headRefName: pr.headRefName ?? `feat/${pr.number}-a-branch`,
  baseRefName: pr.baseRefName ?? "main",
  author: { login: pr.author ?? "dominikwozniak" },
  isCrossRepository: pr.isCrossRepository ?? false,
  mergeable: pr.mergeable ?? "MERGEABLE",
  reviewDecision: pr.reviewDecision ?? "",
  statusCheckRollup: pr.statusCheckRollup ?? [],
  labels: (pr.labels ?? []).map((name) => ({ name }))
})
