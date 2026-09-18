import { Effect } from "effect"
import { CliError } from "effect/unstable/cli"

/**
 * The failures a command owes me a sentence for rather than a stack.
 *
 * Every one of them is a machine or a file that needs fixing, and the message
 * says what to fix. Anything not named here is a fault of the tool's own, and a
 * stack is what I want to see for those.
 */
export const userFacing = ["ConfigMalformed", "GhUnavailable", "GhReadFailed", "GhUnreadable"] as const

/** The same, for a command that also runs `git` against the tool's own clone. */
export const userFacingAndGit = [...userFacing, "GitFailed"] as const

/**
 * The same, for a command that cuts a standing worktree and opens an agent
 * session in it.
 *
 * `dw-mc fix` and `dw-mc resolve` are the two, and they fail the same ways
 * because they do the same thing to different findings: a worktree that holds
 * work of mine and an agent that would not run are the session's failures, not
 * either command's.
 */
export const userFacingAndSession = [...userFacing, "GitFailed", "WorktreeHeld", "AgentFailed"] as const

/** Turns one of those into the sentence the CLI prints, and the exit code it leaves. */
export const asUserError = (cause: unknown): Effect.Effect<never, CliError.UserError> =>
  Effect.fail(new CliError.UserError({ cause }))
