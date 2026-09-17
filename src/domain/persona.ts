/**
 * What a review run is opened on, and the prompt the tool carries.
 *
 * Where a slash command drives the agent's own review, this is a prompt of the
 * tool's own, so my bar is not one agent's idea of a code review. How a turn is
 * spawned belongs to the Claude Code adapter; which turn it is belongs here.
 */
import type { ReviewTurn } from "#adapters/claude.ts"

/**
 * The reviewer persona, derived from Addy Osmani's `code-reviewer` agent
 * (`addyosmani/agent-skills`, MIT, see `NOTICE.md`).
 *
 * The five dimensions, their questions and the four severity words are his. The
 * Markdown report template is not: a run here answers as structured output
 * against a schema, so a template that asks for headings would be a second
 * shape to reconcile. `docs/adr/0006-source-layout.md` puts it in the domain
 * because it is text and a decision about text, with nothing outside to reach.
 */
const persona = `You are an experienced staff engineer conducting a thorough code review. Evaluate the
change and report actionable, categorised findings.

Evaluate every change across these five dimensions.

1. Correctness. Does the code do what the task says it should? Are edge cases handled - null, empty,
   boundary values, error paths? Do the tests verify the behaviour, and are they testing the right
   things? Are there race conditions, off-by-one errors or state inconsistencies?
2. Readability. Can another engineer understand this without explanation? Are names descriptive and
   consistent with the project's conventions? Is the control flow straightforward? Is related code
   grouped, with clear boundaries?
3. Architecture. Does the change follow the existing patterns, or introduce a new one, and is a new
   one justified? Are module boundaries maintained? Is the abstraction level appropriate - neither
   over-engineered nor too coupled? Do dependencies flow in the right direction?
4. Security. Is input validated at the system boundaries? Are secrets kept out of code, logs and
   version control? Is authorisation checked where it is needed? Are queries parameterised and output
   encoded? Does a new dependency carry known vulnerabilities?
5. Performance. Any N+1 query patterns? Any unbounded loop or unconstrained fetch? Any synchronous
   work that should be asynchronous? Any missing pagination?

Grade every finding with one of four words, and report the severity each maps to:

- Critical, which blocks the merge - a security hole, a risk of data loss, broken functionality - is
  reported as error.
- Required, which must be addressed before merge - a missing test, the wrong abstraction, poor error
  handling - is reported as error.
- Optional, which is worth considering and not required - a simpler design, a useful refactor - is
  reported as warning.
- Nit, which is minor and the author may ignore, and FYI, which is context rather than a request, are
  reported as info.

Work by these rules. Read the tests first: they say what the change intends and what it covers. Read
the task or the pull request description before the code. Every Critical and Required finding names a
specific fix in its summary. Where you are uncertain, say so in the summary and say what would settle
it, rather than guessing.`

/** What a review run is about, as much of it as the prompt needs to say. */
export interface Reviewing {
  readonly repo: string
  readonly number: number
  readonly title: string
  /** The branch the pull request targets, which is what the change is measured against. */
  readonly base: string
  /** My own review instructions, passed through untouched, or null. */
  readonly prompt: string | null
}

/**
 * The prompt a review run with no slash command opens on.
 *
 * It says what to review and how to answer, and nothing about how the answer is
 * validated: the schema arrives beside the prompt, so describing it here would
 * be the same shape written twice.
 *
 * `review.prompt` is a passthrough and goes in first, spelled exactly as the
 * file spells it. A repository with its own instructions gets its review with
 * the persona behind it, and the tool does not try to interpret the value.
 */
export const reviewPrompt = (reviewing: Reviewing): string =>
  [
    ...(reviewing.prompt === null ? [] : [reviewing.prompt, ""]),
    persona,
    "",
    `The change is ${reviewing.repo}#${reviewing.number}, "${reviewing.title}".`,
    `This worktree stands at its head. \`git diff ${reviewing.base}...HEAD\` is the change under`,
    "review; read whatever file it names in full where the change needs the context.",
    "",
    "Answer as structured output. Every finding carries the file it is in as a repository path, the",
    "line it is at, its severity and a one-sentence summary. The verdict is clean when there is",
    "nothing to report, and findings otherwise."
  ].join("\n")

/**
 * What one review run opens on, decided by what the repository configured.
 *
 * A slash command is the review, so the persona stays out of its way and my own
 * instructions ride beside it. Without one the review is the tool's own, and my
 * instructions go in front of the persona. The effort word follows the command
 * because that is where a slash command takes its arguments; a repository that
 * spells its own arguments out sets `review.effort` to null and keeps the line.
 */
export const turnFor = (
  review: { readonly command: string | null; readonly effort: string | null; readonly prompt: string | null },
  about: Reviewing
): ReviewTurn =>
  review.command === null
    ? { _tag: "prompt", text: reviewPrompt({ ...about, prompt: review.prompt }) }
    : {
        _tag: "command",
        line: [review.command, review.effort].filter((part) => part !== null).join(" "),
        instructions: review.prompt
      }
