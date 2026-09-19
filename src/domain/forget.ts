import { Effect } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"

import type { Inventory } from "#adapters/store.ts"
import { allKeys, prKey } from "#adapters/store.ts"
import type { Standing } from "#domain/cleanup.ts"
import { standing } from "#domain/cleanup.ts"

/**
 * Whether a key in the state directory is about this pull request, whichever
 * namespace it sits in.
 *
 * Every namespace names a pull request by `prKey`, and the review runs add the
 * head after an `@`. Reading the key rather than a list of namespaces is what
 * lets a namespace added later be forgotten with the rest.
 */
export const isAbout = (key: string, repo: string, number: number): boolean => {
  const slash = key.indexOf("/")
  if (slash < 0) {
    return false
  }
  const rest = key.slice(slash + 1)
  const pr = prKey(repo, number)
  return rest === pr || rest.startsWith(`${pr}@`)
}

/**
 * Removes everything the state directory keeps about one pull request, and
 * says how many keys that was.
 *
 * A pull request it keeps nothing about is forgotten already, so that is none
 * rather than a failure.
 */
export const forget = Effect.fn("forget.forget")(function* (repo: string, number: number) {
  const store = yield* KeyValueStore.KeyValueStore
  const about = (yield* allKeys).filter((key) => isAbout(key, repo, number))
  yield* Effect.forEach(about, (key) => store.remove(key), { discard: true })
  return about.length
})

/**
 * The session worktrees that stand on one pull request.
 *
 * Forgetting takes none of them: each stands on a branch of the tool's own and
 * holds what I committed there, so what the tool does is say they are there.
 */
export const standingOn = (inventory: Inventory, repo: string, number: number): ReadonlyArray<Standing> =>
  standing(inventory).filter((it) => it.repo === repo && it.number === number)
