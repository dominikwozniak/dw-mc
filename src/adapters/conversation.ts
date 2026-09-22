import { DateTime, Effect, Schema } from "effect"

import { readJson } from "#adapters/gh.ts"

/**
 * A pull request's conversation, read two ways. A sweep reads who spoke and
 * when from REST. A command that prints the conversation reads it in full
 * through one GraphQL document, the one read here that leaves REST, because
 * only GraphQL says which threads are settled.
 */

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

/** One thing somebody said on a pull request, in full. */
export interface Remark {
  readonly login: string
  readonly bot: boolean
  readonly at: DateTime.Utc
  readonly body: string
}

/**
 * One strand of a pull request's conversation: a review thread on a line of the
 * diff, or the pull request's own comments, which hang off no path at all.
 */
export interface Thread {
  readonly path: string | null
  readonly line: number | null
  readonly resolved: boolean
  readonly outdated: boolean
  readonly comments: ReadonlyArray<Remark>
}

const Actor = Schema.NullOr(Schema.Struct({ login: Schema.String, __typename: Schema.String }))

const Said = Schema.Struct({ author: Actor, body: Schema.String, createdAt: Schema.DateTimeUtcFromString })

const Conversation = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.Struct({
        pullRequest: Schema.Struct({
          comments: Schema.Struct({ nodes: Schema.Array(Said) }),
          reviews: Schema.Struct({
            nodes: Schema.Array(
              Schema.Struct({
                author: Actor,
                body: Schema.String,
                submittedAt: Schema.NullOr(Schema.DateTimeUtcFromString)
              })
            )
          }),
          reviewThreads: Schema.Struct({
            nodes: Schema.Array(
              Schema.Struct({
                isResolved: Schema.Boolean,
                isOutdated: Schema.Boolean,
                path: Schema.NullOr(Schema.String),
                line: Schema.NullOr(Schema.Int),
                comments: Schema.Struct({ nodes: Schema.Array(Said) })
              })
            )
          })
        })
      })
    })
  })
)

const remark = (
  said: { readonly author: typeof Actor.Type; readonly body: string },
  at: DateTime.Utc | null
): ReadonlyArray<Remark> =>
  said.author === null || at === null || said.body.trim() === ""
    ? []
    : [{ login: said.author.login, bot: said.author.__typename === "Bot", at, body: said.body.trim() }]

const byTime = (self: Remark, other: Remark): number => DateTime.Order(self.at, other.at)

/**
 * A pull request's whole conversation: the comments on it, the bodies of the
 * reviews, and every thread on the diff with whether it is settled.
 *
 * GraphQL rather than the two REST endpoints a sweep reads, because resolution
 * is not in REST at all: a review comment's payload carries `body`, `path`,
 * `line`, `diff_hunk` and `side`, and nothing saying whether somebody closed
 * the thread it belongs to. A thread that was settled a week ago is not
 * something to answer, so the state that says so has to arrive with it.
 *
 * The pull request's own comments and the reviews' bodies come back as one
 * strand under no path, in the order they were written: they are one
 * conversation as it happened, and which endpoint each line came from is an
 * accident of GitHub's model rather than anything to read.
 *
 * `__typename` is what says a bot is a bot, the way `user.type` does in REST.
 */
export const prConversation = Effect.fnUntraced(function* (repo: string, number: number) {
  const [owner = repo, name = repo] = repo.split("/")
  // The document is spelled out here rather than held in a constant, because
  // every GraphQL call is a POST and the document is the only thing that says
  // whether it reads or writes: `no-gh-writes` reads it at this call site and
  // refuses one it cannot.
  const answer = yield* readJson(
    "api graphql",
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `query=query($owner:String!,$name:String!,$number:Int!){
        repository(owner:$owner,name:$name){
          pullRequest(number:$number){
            comments(last:100){nodes{author{login __typename} body createdAt}}
            reviews(last:100){nodes{author{login __typename} body submittedAt}}
            reviewThreads(last:100){nodes{
              isResolved isOutdated path line
              comments(first:100){nodes{author{login __typename} body createdAt}}
            }}
          }
        }
      }`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${number}`
    ],
    Conversation
  )

  const pr = answer.data.repository.pullRequest
  const conversation = [
    ...pr.comments.nodes.flatMap((it) => remark(it, it.createdAt)),
    ...pr.reviews.nodes.flatMap((it) => remark(it, it.submittedAt))
  ].toSorted(byTime)

  const threads = pr.reviewThreads.nodes.map((it): Thread => ({
    path: it.path,
    line: it.line,
    resolved: it.isResolved,
    outdated: it.isOutdated,
    comments: it.comments.nodes.flatMap((comment) => remark(comment, comment.createdAt)).toSorted(byTime)
  }))

  return [
    ...(conversation.length === 0
      ? []
      : [{ path: null, line: null, resolved: false, outdated: false, comments: conversation } satisfies Thread]),
    ...threads
  ] satisfies ReadonlyArray<Thread>
})
