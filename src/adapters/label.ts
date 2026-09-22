import { Effect, Schema } from "effect"

import { failedAs, readJson } from "#adapters/gh.ts"
import { capture } from "#adapters/spawner.ts"

const Label = Schema.fromJsonString(Schema.Struct({ name: Schema.String }))

/** A label's path under its repository: GitHub names a label in the URL, so a space or a colon is escaped. */
const labelPath = (name: string): string => encodeURIComponent(name)

/**
 * Whether `repo` defines the label `name`.
 *
 * Asked before a label is added, because the endpoint that adds one creates a
 * label the repository does not have, and the labels a repository offers are
 * the team's to decide. A 404 is the answer "no"; anything else `gh` refuses
 * is a failure.
 */
export const labelDefined = Effect.fnUntraced(function* (repo: string, name: string) {
  return yield* readJson("api label", "gh", ["api", `repos/${repo}/labels/${labelPath(name)}`], Label).pipe(
    Effect.as(true),
    Effect.catchTag("GhReadFailed", (error) =>
      error.detail.includes("HTTP 404") ? Effect.succeed(false) : Effect.fail(error)
    )
  )
})

/**
 * Puts the review label `name` on a pull request I author (ADR 0012).
 *
 * REST rather than `gh pr edit --add-label`: that edit goes through GraphQL,
 * which on a `gh` older than 2.82.1 asks for the retired Projects (classic)
 * fields and aborts before the label lands.
 */
export const addLabel = Effect.fnUntraced(function* (repo: string, number: number, name: string) {
  yield* capture("gh", ["api", "-X", "POST", `repos/${repo}/issues/${number}/labels`, "-f", `labels[]=${name}`]).pipe(
    failedAs("api add label")
  )
})

/**
 * Takes the review label `name` off a pull request I author (ADR 0012).
 *
 * A label already gone answers 404, and that is the state this was asked for,
 * so it counts as done.
 */
export const removeLabel = Effect.fnUntraced(function* (repo: string, number: number, name: string) {
  yield* capture("gh", ["api", "-X", "DELETE", `repos/${repo}/issues/${number}/labels/${labelPath(name)}`]).pipe(
    failedAs("api remove label"),
    Effect.catchTag("GhReadFailed", (error) => (error.detail.includes("HTTP 404") ? Effect.void : Effect.fail(error)))
  )
})
