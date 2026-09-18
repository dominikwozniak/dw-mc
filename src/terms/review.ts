/**
 * The words a review run is described in.
 *
 * What a run opens on and how much it spends are facts about Claude Code, and
 * how much a finding weighs is a rule of mine, but all three are read on both
 * sides of the adapter seam: the domain writes the turn and weighs the
 * findings, the adapter spawns the turn and is held to the same words.
 */
import { Schema } from "effect"

/**
 * How much a review run spends, in the words the slash command takes.
 *
 * The set is Claude Code's and not this tool's, so it is wider than three
 * words: a run that would be worth `max` is one I should be able to ask for
 * without spelling the whole command out.
 */
export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"])
export type Effort = typeof Effort.Type

/** How much a finding weighs. */
export const Severity = Schema.Literals(["error", "warning", "info"])
export type Severity = typeof Severity.Type

/**
 * What one review run opens on: a slash command, or the tool's own prompt.
 *
 * Which of the two it is decides how many turns the run takes, which is a fact
 * about Claude Code; what the turn says is the domain's. Neither owns the
 * shape, so it sits under both.
 */
export type ReviewTurn =
  | {
      readonly _tag: "command"
      /** The slash command and whatever follows it, as one line. */
      readonly line: string
      /** What else the run is told to look at, on the system prompt beside the command. */
      readonly instructions: string | null
    }
  | { readonly _tag: "prompt"; readonly text: string }
