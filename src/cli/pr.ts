import { Effect } from "effect"
import { Argument, CliError } from "effect/unstable/cli"

import type { Reference } from "#domain/reference.ts"
import { resolve } from "#domain/reference.ts"

/** The pull request a command acts on, named the way I actually type it. */
export const prArgument = Argument.String("pr").pipe(
  Argument.withDescription("The pull request, as 28 or owner/name#28")
)

/** What to say about a reference that named no one pull request. */
const whyNothingNamed = (reference: Exclude<Reference, { readonly _tag: "resolved" }>): string => {
  if (reference._tag === "unreadable") {
    return `'${reference.text}' is not a pull request. Name one as 28, or as owner/name#28.`
  }
  const example = `${reference.repos[0] ?? "owner/name"}#28`
  return reference.repos.length === 0
    ? `No repositories are registered, so a number alone names nothing. ` +
        `Run dw-mc init inside a repository, or name the pull request as ${example}.`
    : `${reference.repos.length} repositories are registered, so a number alone could be any of them. ` +
        `Name the pull request as ${example}.`
}

/** The pull request the argument names, or the sentence saying why it names none. */
export const named = (pr: string, registered: ReadonlyArray<string>) => {
  const reference = resolve(pr, registered)
  return reference._tag === "resolved"
    ? Effect.succeed(reference)
    : Effect.fail(new CliError.UserError({ cause: whyNothingNamed(reference) }))
}
