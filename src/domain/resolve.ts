import { Effect, Schema } from "effect"

import type { Branch } from "#domain/rebase.ts"
import { boundary } from "#domain/rebase.ts"
import { short } from "#domain/review.ts"

/** Everything the resolve guards are allowed to know about a pull request. */
export interface Situation extends Branch {
  /** Where the pull request is now. */
  readonly head: string
  /** The head a conflict was recorded at, or null where none was. */
  readonly conflictAt: string | null
}

/**
 * Why this conflict is not one to open a session on, or null where it is.
 *
 * `rebase.enabled` is not asked. That key exists so a force push is never a
 * surprise, and the only push here is my own from the worktree; a session that
 * writes nothing needs no permission to push.
 *
 * The branch's own guards are the same ones a rebase reads, because they are
 * about the branch rather than about what is done to it: a pull request I did
 * not author, one whose branch lives in a fork and one in a stack are none of
 * this tool's business whichever command asks.
 *
 * What is left is this command's own: a conflict is recorded against the head
 * it happened at, so a branch that has moved past it is one nothing here has
 * tried to rebase yet. Either way the answer is the same command, because a
 * conflict to resolve is one a rebase hit.
 */
export const decide = (situation: Situation): string | null => {
  const refused = boundary(situation)
  if (refused !== null) {
    return refused
  }
  const where = `${situation.repo}#${situation.number}`
  if (situation.conflictAt === null) {
    return (
      `${where} has no conflict recorded at ${short(situation.head)}. ` +
      `Run dw-mc rebase ${situation.number}: a conflict to resolve is one a rebase hit.`
    )
  }
  if (situation.conflictAt !== situation.head) {
    return (
      `The conflict on ${where} was recorded at ${short(situation.conflictAt)} and the branch is now at ` +
      `${short(situation.head)}. Run dw-mc rebase ${situation.number} to see what the head it is at hits.`
    )
  }
  return null
}

/** The conflict a session opens on: where it happened, and what it stopped on. */
export const Conflicted = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int,
  head: Schema.String,
  /** The branch the pull request merges into, which is what the replay stopped against. */
  base: Schema.String,
  /** What the pull request is for, which is what its conflicting hunks have to keep meaning. */
  title: Schema.String,
  paths: Schema.Array(Schema.String)
})
export type Conflicted = typeof Conflicted.Type

/** The conflict as the JSON the schema defines, rather than as this file spells it. */
const asJson = Schema.encodeEffect(Schema.fromJsonString(Conflicted))

/**
 * The prompt a resolve session opens on: what stopped the replay, and the
 * conflict itself as JSON.
 *
 * The paths go in verbatim rather than described, for the reason a fix
 * session's findings do: a re-description is where a path quietly changes. The
 * title goes in because a hunk is resolved against what the pull request is
 * for, and the base because the two sides of every conflict are the branch and
 * it.
 *
 * The rebase stays mine to finish. The session works the files and stops
 * there: continuing the rebase, committing and pushing are three things I do
 * after reading what it did, and a session that did them would be resolving the
 * conflict for me rather than with me.
 */
export const promptFor = (conflicted: Conflicted): Effect.Effect<string, Schema.SchemaError> =>
  Effect.map(asJson(conflicted), (json) =>
    [
      `A dw-mc rebase of ${conflicted.repo}#${conflicted.number} onto ${conflicted.base} stopped on a conflict. ` +
        `You are in a worktree standing on the pull request's commits at ${short(conflicted.head)}, ` +
        `with that rebase in progress and the files below unmerged.`,
      `The pull request is "${conflicted.title}". Resolve each file so it keeps meaning that and keeps ` +
        `whatever ${conflicted.base} changed underneath it; where the two cannot both hold, say so and stop.`,
      `Do not run git rebase --continue, do not commit and do not push. I read the resolution and do all three ` +
        `myself.`,
      json
    ].join("\n\n")
  )
