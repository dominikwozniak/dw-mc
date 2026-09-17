import { DateTime, Effect, Match, PlatformError, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"

import { capture } from "#adapters/spawner.ts"
import type { Mergeability, ReviewDecision } from "#terms/pr.ts"

/** `gh` is on the machine but would not run. */
export class GhUnavailable extends Schema.TaggedError<GhUnavailable>()("GhUnavailable", {
  detail: Schema.String
}) {
  override get message(): string {
    return `gh could not be run: ${this.detail}\nInstall it from https://cli.github.com, then run 'gh auth login'.`
  }
}

/** `gh` runs but is not logged in, so every read of GitHub would fail. */
export class GhUnauthenticated extends Schema.TaggedError<GhUnauthenticated>()("GhUnauthenticated", {
  detail: Schema.String
}) {
  override get message(): string {
    return `gh is not authenticated. Run 'gh auth login'.\n${this.detail}`
  }
}

/** The working directory is not inside a repository `gh` can name. */
export class NoRepository extends Schema.TaggedError<NoRepository>()("NoRepository", {
  detail: Schema.String
}) {
  override get message(): string {
    return `This directory is not a GitHub repository dw-mc can register.\n${this.detail}`
  }
}

/** `gh` answered, in a shape this version of dw-mc does not know. */
export class GhUnreadable extends Schema.TaggedError<GhUnreadable>()("GhUnreadable", {
  command: Schema.String,
  reason: Schema.String
}) {
  override get message(): string {
    return `gh ${this.command} answered with something dw-mc cannot read: ${this.reason}`
  }
}

/** What a `gh` that would not even start comes to. */
export const unavailable = (error: PlatformError.PlatformError): GhUnavailable =>
  new GhUnavailable({
    detail: error.reason._tag === "NotFound" ? "it is not installed" : error.message
  })

/**
 * Stops unless `gh` is installed and logged in.
 *
 * Every read of GitHub goes through `gh` as me, so a missing or logged-out `gh`
 * is worth saying once, up front, rather than as an empty table later.
 */
export const requireAuth: Effect.Effect<
  void,
  GhUnavailable | GhUnauthenticated,
  ChildProcessSpawner.ChildProcessSpawner
> = capture("gh", ["auth", "status"]).pipe(
  Effect.asVoid,
  Effect.catchTags({
    PlatformError: (error) => Effect.fail(unavailable(error)),
    CommandFailed: (error) => Effect.fail(new GhUnauthenticated({ detail: error.stderr }))
  }),
  Effect.withSpan("gh.requireAuth")
)

const RepoView = Schema.fromJsonString(Schema.Struct({ nameWithOwner: Schema.String }))

/** The `owner/repo` of the repository the working directory is in. */
export const currentRepo: Effect.Effect<
  string,
  GhUnavailable | NoRepository | GhUnreadable,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const json = yield* capture("gh", ["repo", "view", "--json", "nameWithOwner"]).pipe(
    Effect.catchTags({
      PlatformError: (error) => Effect.fail(unavailable(error)),
      CommandFailed: (error) => Effect.fail(new NoRepository({ detail: error.stderr }))
    })
  )

  const view = yield* Schema.decodeEffect(RepoView)(json).pipe(
    Effect.mapError((error) => new GhUnreadable({ command: "repo view", reason: error.message }))
  )
  return view.nameWithOwner
}).pipe(Effect.withSpan("gh.currentRepo"))

/** A call to GitHub that `gh` itself refused, whether it was reading or writing. */
export class GhReadFailed extends Schema.TaggedError<GhReadFailed>()("GhReadFailed", {
  command: Schema.String,
  detail: Schema.String
}) {
  override get message(): string {
    return `gh ${this.command} failed: ${this.detail}`
  }
}

/** Anything that can go wrong reading GitHub through `gh`. */
export type GhError = GhUnavailable | GhReadFailed | GhUnreadable

/** One `gh` read, decoded, with every way it can go wrong in our words. */
export const readJson = <A>(
  label: string,
  command: string,
  args: ReadonlyArray<string>,
  schema: Schema.Codec<A, string>
): Effect.Effect<A, GhError, ChildProcessSpawner.ChildProcessSpawner> =>
  capture(command, args).pipe(
    Effect.catchTags({
      PlatformError: (error) => Effect.fail(unavailable(error)),
      CommandFailed: (error) => Effect.fail(new GhReadFailed({ command: label, detail: error.stderr }))
    }),
    Effect.flatMap((json) =>
      Schema.decodeEffect(schema)(json).pipe(
        Effect.mapError((error) => new GhUnreadable({ command: label, reason: error.message }))
      )
    ),
    Effect.withSpan(`gh.${label}`)
  )

const User = Schema.fromJsonString(Schema.Struct({ login: Schema.String }))

/** The login `gh` is authenticated as: the "me" every read is scoped to. */
export const viewer: Effect.Effect<string, GhError, ChildProcessSpawner.ChildProcessSpawner> = readJson(
  "api user",
  "gh",
  ["api", "user"],
  User
).pipe(Effect.map((user) => user.login))

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

/**
 * One entry of a PR's status check rollup.
 *
 * A rollup mixes two shapes: a `CheckRun` reports a `status` and a `conclusion`,
 * a `StatusContext` an overall `state`. Every field is optional because which
 * ones arrive depends on which shape it is.
 */
export const CheckEntry = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  conclusion: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  /** The workflow the check runs in. A commit status belongs to no workflow. */
  workflowName: Schema.optionalKey(Schema.String),
  /** Where the check reports, which is the only place its job id appears. */
  detailsUrl: Schema.optionalKey(Schema.String)
})
export type CheckEntry = typeof CheckEntry.Type

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
    statusCheckRollup: Schema.NullOr(Schema.Array(CheckEntry))
  })
)
export type PrView = typeof PrView.Type

const viewFields =
  "number,title,url,isDraft,headRefOid,headRefName,baseRefName,author,isCrossRepository,mergeable," +
  "reviewDecision,statusCheckRollup"

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

const Comments = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      created_at: Schema.DateTimeUtcFromString,
      user: Schema.NullOr(Schema.Struct({ login: Schema.String, type: Schema.String }))
    })
  )
)

/** Who wrote a comment and when. */
export interface Comment {
  readonly login: string
  readonly bot: boolean
  readonly at: DateTime.Utc
}

const comments = (label: string, path: string) =>
  readJson(label, "gh", ["api", path], Comments).pipe(
    Effect.map((all) =>
      all.flatMap((comment): ReadonlyArray<Comment> =>
        comment.user === null
          ? []
          : [{ login: comment.user.login, bot: comment.user.type === "Bot", at: comment.created_at }]
      )
    )
  )

/**
 * Every comment on a pull request: the ones on the conversation and the ones
 * left on the diff.
 *
 * REST is what says whether an author is a person or an app - `gh pr view`
 * reports a bot's login with no sign that it is one - and the bucket rules turn
 * on exactly that. Verified by running both: the endpoints ignore `direction`,
 * so a page is asked for at its maximum and the newest comment is picked out of
 * it rather than asked for first.
 */
export const prComments = Effect.fnUntraced(function* (repo: string, number: number) {
  const page = "per_page=100"
  const [conversation, onDiff] = yield* Effect.all(
    [
      comments("api issue comments", `repos/${repo}/issues/${number}/comments?${page}`),
      comments("api review comments", `repos/${repo}/pulls/${number}/comments?${page}`)
    ],
    { concurrency: 2 }
  )
  return [...conversation, ...onDiff]
})

const Reviews = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      submitted_at: Schema.DateTimeUtcFromString,
      body: Schema.String,
      user: Schema.NullOr(Schema.Struct({ login: Schema.String, type: Schema.String }))
    })
  )
)

/**
 * The reviews on a pull request that said something, as comments.
 *
 * A review carries a body of its own, which is where a reviewer writes the
 * sentence that is not attached to any line. An empty body is a verdict and
 * nothing more, and the verdict arrives with the PR as `reviewDecision`.
 */
export const prReviews = Effect.fnUntraced(function* (repo: string, number: number) {
  const all = yield* readJson(
    "api reviews",
    "gh",
    ["api", `repos/${repo}/pulls/${number}/reviews?per_page=100`],
    Reviews
  )

  return all.flatMap((review): ReadonlyArray<Comment> =>
    review.user === null || review.body.trim() === ""
      ? []
      : [{ login: review.user.login, bot: review.user.type === "Bot", at: review.submitted_at }]
  )
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
    Effect.catchTags({
      PlatformError: (error) => Effect.fail(unavailable(error)),
      CommandFailed: (error) => Effect.fail(new GhReadFailed({ command: "pr merge", detail: error.stderr }))
    })
  )
})
