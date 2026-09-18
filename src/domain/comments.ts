import type { Thread } from "#adapters/conversation.ts"
import type { Moment } from "#domain/moment.ts"
import { isAfter, newest } from "#domain/moment.ts"

/**
 * A pull request's conversation as it goes on screen: what people said, and
 * under a rule of its own what the bots did.
 *
 * They are kept apart rather than ordered together because they are read for
 * different reasons. A person's comment is a thing to answer; a bot's is a
 * thing to look at, and the bucket rules already ignore it.
 */
export interface Shown {
  readonly people: ReadonlyArray<Thread>
  readonly bots: ReadonlyArray<Thread>
}

/**
 * One thread's share of a strand, cut to what is worth reading.
 *
 * A review thread is answered as a whole, so a single comment newer than my
 * last activity brings the whole thread with it: the follow-up on its own is a
 * line answering something the screen does not show, which is what sends me to
 * the browser.
 *
 * The pull request's own comments are not a thread but a stream, and there is
 * no reply to lose the question of, so they are cut comment by comment.
 */
const only = (thread: Thread, keep: (bot: boolean) => boolean, since: Moment, all: boolean): ReadonlyArray<Thread> => {
  const strand = thread.comments.filter((it) => keep(it.bot))
  const comments = all
    ? strand
    : thread.path === null
      ? strand.filter((it) => isAfter(it.at, since))
      : strand.some((it) => isAfter(it.at, since))
        ? strand
        : []
  return comments.length === 0 ? [] : [{ ...thread, comments }]
}

/**
 * The threads worth putting on screen, given what I have already done.
 *
 * `since` is my last activity on the pull request - the later of my last
 * comment and my last commit - which is the same moment the bucket rule
 * measures a comment against. Showing exactly what is newer than it means the
 * command answers the question the bucket asked.
 *
 * A thread somebody resolved and one against code that is gone are left out:
 * neither is something to answer, and both are still there to read under
 * `--all`, which asks for the whole conversation and so measures nothing
 * against anything.
 */
export const shown = (threads: ReadonlyArray<Thread>, options: { readonly since: Moment; readonly all: boolean }) => {
  const kept = options.all ? threads : threads.filter((it) => !it.resolved && !it.outdated)
  return {
    people: kept.flatMap((it) => only(it, (bot) => !bot, options.since, options.all)),
    bots: kept.flatMap((it) => only(it, (bot) => bot, options.since, options.all))
  } satisfies Shown
}

/**
 * The comment an acknowledgement of this conversation covers: the newest thing
 * a person said in it, whichever thread it is in.
 *
 * The whole conversation rather than what went on screen, because the bucket
 * rule counts the whole of it: a comment on a thread somebody resolved still
 * puts the pull request in Needs me, and an acknowledgement that stopped short
 * of it would settle nothing. A bot is left out for the reason the rule leaves
 * it out.
 *
 * It is a comment's own moment and never the clock's, so a comment written
 * after the conversation was read is one the acknowledgement does not cover.
 */
export const acknowledging = (threads: ReadonlyArray<Thread>): Moment =>
  newest(threads.flatMap((thread) => thread.comments.filter((it) => !it.bot).map((it) => it.at)))
