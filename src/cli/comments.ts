import { Console, DateTime, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import type { Thread } from "#adapters/conversation.ts"
import { prConversation } from "#adapters/conversation.ts"
import type { Paint } from "#adapters/paint.ts"
import { Paint as PaintService } from "#adapters/paint.ts"
import { asUserError, userFacing } from "#cli/exit.ts"
import { forPr, prArgument, reading, swept } from "#cli/pr.ts"
import { heading } from "#cli/row.ts"
import type { Facts } from "#domain/bucket.ts"
import { place, unanswered } from "#domain/bucket.ts"
import type { Shown } from "#domain/comments.ts"
import { shown } from "#domain/comments.ts"
import { later } from "#domain/moment.ts"

const allFlag = Flag.Boolean("all").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print the whole conversation, including what is resolved, outdated and already answered")
)

/** Where a thread hangs: a line of the diff, or the pull request itself. */
const where = (thread: Thread): string =>
  thread.path === null ? "Conversation" : thread.line === null ? thread.path : `${thread.path}:${thread.line}`

/**
 * What is true of a thread beyond where it hangs.
 *
 * It is only ever printed under `--all`, which is the only way a settled thread
 * reaches the screen at all, and it is there so that reading one is never
 * reading it as something still open.
 */
const settled = (thread: Thread): string =>
  [thread.resolved ? "resolved" : null, thread.outdated ? "outdated" : null].filter((it) => it !== null).join(", ")

/**
 * One thread as a block: where it hangs, then everybody who said something in
 * it, then what they said in full.
 *
 * In full because a review comment is usually a paragraph carrying a
 * suggestion, and a first line is what sends me to the browser this command
 * exists to replace. No diff hunk with it: the code is on this machine, under
 * the path the heading already prints.
 */
const block = (thread: Thread, paint: Paint): ReadonlyArray<string> => [
  `${paint.bold(where(thread))}${settled(thread) === "" ? "" : paint.dim(`  (${settled(thread)})`)}`,
  ...thread.comments.flatMap((comment) => [
    `  ${paint.dim(`@${comment.login}  ${DateTime.formatIso(comment.at)}`)}`,
    ...comment.body.split("\n").map((line) => `    ${line}`)
  ])
]

const separated = (blocks: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> =>
  blocks.flatMap((lines, index) => (index === 0 ? lines : ["", ...lines]))

/**
 * The conversation on screen: people first, then a rule, then the bots.
 *
 * The rule is there so the two are never read as one list. A bot's comment is
 * observed and never answered, and the bucket rules ignore bots for exactly
 * this reason.
 *
 * A bot is cut at the same moment I am measured against, because the window is
 * what has happened since I last acted rather than what is owed an answer. A
 * verdict older than my last push is one I have already had the chance to read,
 * and `--all` is where it still is.
 */
export const lines = (view: Shown, paint: Paint): ReadonlyArray<string> => {
  const people = view.people.map((thread) => block(thread, paint))
  const bots = view.bots.map((thread) => block(thread, paint))
  return separated([...people, ...(bots.length === 0 ? [] : [[paint.dim("── bots ──")], ...bots])])
}

/** What to say where there is nothing to print, which depends on why there is not. */
const nothing = (facts: Facts, all: boolean): ReadonlyArray<string> => {
  const pr = `${facts.repo}#${facts.number}`
  if (all) {
    return [`Nothing has been said on ${pr}.`]
  }
  const placement = place(facts)
  const rest = `dw-mc comments ${facts.number} --all prints the whole conversation.`
  return placement.bucket === "needs-me" && placement.reason === unanswered
    ? [
        `Nothing here is waiting on you: every thread is resolved, outdated, or older than your last comment ` +
          `or commit.`,
        `${pr} sits in ${heading[placement.bucket]} all the same, and a reply or a push is what settles it.`,
        rest
      ]
    : [`Nothing has been said on ${pr} since your last comment or commit.`, rest]
}

/**
 * The conversation on one tracked pull request, and nothing else.
 *
 * What it shows by default is what the bucket rule measures: the comments newer
 * than the later of my last comment and my last commit, which are the ones that
 * put the pull request in Needs me. Reading it answers the question the table
 * asked.
 *
 * The cutoff is read off the last sweep rather than worked out again here, so
 * the command shows exactly what `dw-mc status` counted rather than a second
 * opinion about it.
 *
 * It writes nothing, here or on GitHub: no reply, no resolve, no reaction
 * (ADR 0002). Reading is the whole command.
 */
export const comments = Command.make(
  "comments",
  { pr: prArgument, all: allFlag },
  Effect.fn("comments")(
    function* ({ all, pr }) {
      const { number, repo } = yield* forPr(pr)

      const facts = yield* swept(repo, number)
      const paint = yield* PaintService
      const view = shown(yield* reading(`${repo}#${number}`, prConversation(repo, number)), {
        since: later(facts.myLastCommentAt, facts.myLastCommitAt),
        all
      })

      if (view.people.length === 0 && view.bots.length === 0) {
        yield* Effect.forEach(nothing(facts, all), (line) => Console.log(line))
        return
      }

      yield* Console.log(paint.bold(`${repo}#${number}`) + `  ${paint.dim(facts.title)}`)
      yield* Console.log("")
      yield* Effect.forEach(lines(view, paint), (line) => Console.log(line))
    },
    Effect.catchTag(userFacing, asUserError)
  )
).pipe(Command.withDescription("Print the conversation on one pull request, and what is waiting on me in it"))
