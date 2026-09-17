import { DateTime, Effect, Schema } from "effect"

import { readJson } from "#adapters/gh.ts"

/**
 * A pull request's conversation, which is the one read that leaves REST.
 *
 * It sits beside `gh.ts` rather than in it because it is a boundary of its own:
 * one GraphQL document, decoded into the threads a command prints, where every
 * other read of GitHub here is a `gh` subcommand or a REST endpoint.
 */

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
