import type { Facts, Placed } from "#domain/bucket.ts"

/**
 * One of the moves the picker can make on a tracked PR.
 *
 * Every one of them is a command that already exists, because the picker is a
 * front door rather than a second implementation: what it does with my answer
 * is run the command I would have typed.
 */
export type Action = "resolve" | "rerun" | "review" | "findings" | "fix" | "rebase" | "withdraw"

/** An action on offer, with the words the picker shows for it. */
export interface Offer {
  readonly action: Action
  readonly title: string
}

/** A tracked PR as the picker sees it: where it sits, and what is true of it now. */
export interface Standing {
  readonly placed: Placed
  /** Whether it carries my stamp at this head. */
  readonly stamped: boolean
  /** Whether its repository turned rebase on. */
  readonly rebasing: boolean
  /** The head its flaky CI was already re-run at, or null where none has been. */
  readonly rerunAt: string | null
}

/**
 * The actions worth offering on one tracked PR, in the order I would take them.
 *
 * An action is offered only where it has something to act on, so the list is
 * what I can do rather than what the binary can spell: a report nothing has
 * written is not on it, and neither is a rebase the repository has not turned
 * on. A command still refuses for its own reasons when I pick it; this only
 * keeps me from picking one that was never going to do anything.
 *
 * Everything is measured against the current head. A review run or a conflict
 * recorded at a head that has gone says nothing about the branch as it is now,
 * which is the same rule the buckets are placed by.
 *
 * Resolving a conflict comes first for the reason a conflict is the first thing
 * that makes a PR mine: it makes every other signal on the PR stale.
 */
export const actionsFor = ({ placed, rebasing, rerunAt, stamped }: Standing): ReadonlyArray<Offer> => {
  const { facts } = placed
  const reviewed = facts.reviewRunHead === facts.head

  return [
    facts.rebaseConflictAt === facts.head
      ? { action: "resolve" as const, title: "Open a session on the rebase conflict" }
      : null,
    facts.checks === "red" && facts.ciFlaky !== null && rerunAt !== facts.head
      ? { action: "rerun" as const, title: "Run the flaky CI again, once" }
      : null,
    { action: "review" as const, title: reviewed ? "Review this head again" : "Run a review" },
    reviewed ? { action: "findings" as const, title: "Show the review-run report" } : null,
    reviewed ? { action: "fix" as const, title: "Open a fix session on the findings" } : null,
    rebasing ? { action: "rebase" as const, title: "Rebase onto the base and push" } : null,
    stamped ? { action: "withdraw" as const, title: "Withdraw the stamp, until the head changes" } : null
  ].filter((offer) => offer !== null)
}

/**
 * The arguments the picked action runs as, named the way the commands take it.
 *
 * The pull request is spelled in full, repository and all, so the argument
 * names one pull request whatever else is registered.
 */
export const argvFor = (action: Action, facts: Facts): ReadonlyArray<string> => {
  const pr = `${facts.repo}#${facts.number}`
  return action === "withdraw" ? ["stamp", pr, "--withdraw"] : [action, pr]
}
