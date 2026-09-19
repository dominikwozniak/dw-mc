import { DateTime, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import type { Thread } from "#adapters/conversation.ts"
import { prConversation } from "#adapters/conversation.ts"
import type { Paint } from "#adapters/paint.ts"
import { Paint as PaintService } from "#adapters/paint.ts"
import { block, following, indent, print, separated } from "#cli/block.ts"
import { asUserError, userFacing } from "#cli/exit.ts"
import { forPr, prArgument, reading, swept } from "#cli/pr.ts"
import { heading } from "#cli/row.ts"
import { acknowledge } from "#domain/acknowledgement.ts"
import type { Facts } from "#domain/bucket.ts"
import { answeredAt, place, unanswered } from "#domain/bucket.ts"
import type { Shown } from "#domain/comments.ts"
import { acknowledging, shown } from "#domain/comments.ts"

const allFlag = Flag.Boolean("all").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print the whole conversation, including what is resolved, outdated and already answered")
)

const ackFlag = Flag.Boolean("ack").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Record that I have read the conversation and nothing in it is mine to answer")
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
const threadBlock = (thread: Thread, paint: Paint): ReadonlyArray<string> =>
  block(
    `${where(thread)}${settled(thread) === "" ? "" : paint.dim(`  (${settled(thread)})`)}`,
    thread.comments.flatMap((comment) => [
      paint.dim(`@${comment.login}  ${DateTime.formatIso(comment.at)}`),
      ...comment.body.split("\n").map(indent)
    ])
  )

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
const blocks = (view: Shown, paint: Paint): ReadonlyArray<ReadonlyArray<string>> => {
  const people = view.people.map((thread) => threadBlock(thread, paint))
  const bots = view.bots.map((thread) => threadBlock(thread, paint))
  return [...people, ...(bots.length === 0 ? [] : [[paint.dim("── bots ──")], ...bots])]
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
        `Nothing here is waiting on you: every thread is resolved, outdated, or older than your last comment, ` +
          `commit or acknowledgement.`,
        `${pr} sits in ${heading[placement.bucket]} all the same, and a reply, a push or ` +
          `dw-mc comments ${facts.number} --ack is what settles it.`,
        rest
      ]
    : [`Nothing has been said on ${pr} since your last comment, commit or acknowledgement.`, rest]
}

/**
 * Records an acknowledgement of the conversation read, and says what it covers
 * and where the pull request sits with it.
 *
 * Where it sits is worked out from the last sweep with the acknowledgement laid
 * over it, which is the same answer the next sweep gives unless somebody says
 * something new in between.
 */
const acknowledged = Effect.fn("comments.acknowledged")(function* (facts: Facts, threads: ReadonlyArray<Thread>) {
  const pr = `${facts.repo}#${facts.number}`
  const at = acknowledging(threads)
  if (at === null) {
    return [`Nothing to acknowledge: nobody has said anything on ${pr}.`]
  }
  yield* acknowledge(facts.repo, facts.number, at)
  const placement = place({ ...facts, acknowledgedAt: at })
  return [
    `Acknowledged everything said on ${pr} up to ${DateTime.formatIso(at)}.`,
    `${pr} sits in ${heading[placement.bucket]}: ${placement.reason}.`
  ]
})

/**
 * The conversation on one tracked pull request, and nothing else.
 *
 * What it shows by default is what the bucket rule measures: the comments newer
 * than the latest of my last comment, my last commit and my acknowledgement,
 * which are the ones that put the pull request in Needs me. Reading it answers
 * the question the table asked.
 *
 * The cutoff is read off the last sweep rather than worked out again here, so
 * the command shows exactly what `dw-mc status` counted rather than a second
 * opinion about it.
 *
 * It writes nothing to GitHub: no reply, no resolve, no reaction (ADR 0002).
 * `--ack` is the one thing it writes at all, and only on this machine: whether a
 * comment needs an answer is known after reading it, so reading cannot be what
 * decides it.
 */
export const comments = Command.make(
  "comments",
  { pr: prArgument, all: allFlag, ack: ackFlag },
  Effect.fn("comments")(
    function* ({ ack, all, pr }) {
      const { number, repo } = yield* forPr(pr)

      const facts = yield* swept(repo, number)
      const paint = yield* PaintService
      const threads = yield* reading(`${repo}#${number}`, prConversation(repo, number))
      const view = shown(threads, { since: answeredAt(facts), all })

      yield* print(
        view.people.length === 0 && view.bots.length === 0
          ? nothing(facts, all)
          : separated([[`${repo}#${number}  ${paint.dim(facts.title)}`], ...blocks(view, paint)])
      )

      if (ack) {
        yield* print(following([yield* acknowledged(facts, threads)]))
      }
    },
    Effect.catchTag(userFacing, asUserError)
  )
).pipe(
  Command.withDescription(
    "Print the conversation on one pull request and what is waiting on me in it, and with --ack record that I read it"
  )
)
