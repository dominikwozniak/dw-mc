import { Effect } from "effect"

import type { Settings } from "#adapters/config.ts"
import { addLabel, labelDefined, removeLabel } from "#adapters/label.ts"
import type { Labelled } from "#domain/label.ts"
import { relabel } from "#domain/label.ts"

/**
 * Brings a pull request's review label in line with its head, and says what it
 * could not do.
 *
 * A label is a courtesy to whoever reads the pull request, never what a command
 * is for, so nothing here fails: a write `gh` refused comes back as a sentence
 * for the caller to print beside its own output. A label the repository does
 * not define is left off with the command that would define it, because
 * defining one is the team's call (ADR 0012).
 */
export const relabelPr = Effect.fn("label.relabelPr")(function* (options: {
  readonly repo: string
  readonly number: number
  readonly pr: Labelled
  readonly labels: Settings["labels"]
  readonly onPr: ReadonlyArray<string>
}) {
  const { labels, number, onPr, pr, repo } = options
  const wanted = relabel(pr, labels, onPr)
  const said: Array<string> = []

  for (const name of wanted.remove) {
    yield* removeLabel(repo, number, name).pipe(
      Effect.catch((error) => Effect.sync(() => said.push(`could not take "${name}" off: ${error.message}`)))
    )
  }

  const add = wanted.add
  if (add !== null) {
    yield* Effect.gen(function* () {
      if (!(yield* labelDefined(repo, add))) {
        said.push(`"${add}" is not a label on ${repo}. Run gh label create "${add}" --repo ${repo}`)
        return
      }
      yield* addLabel(repo, number, add)
    }).pipe(Effect.catch((error) => Effect.sync(() => said.push(`could not put "${add}" on: ${error.message}`))))
  }

  return said
})
