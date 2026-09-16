/**
 * What I typed to name a pull request, once it is known which one that is.
 *
 * A number alone is what I actually type, so it resolves against the registered
 * repositories rather than being refused; where that cannot decide, the answer
 * says so instead of guessing a repository.
 */
export type Reference =
  | { readonly _tag: "resolved"; readonly repo: string; readonly number: number }
  | { readonly _tag: "ambiguous"; readonly repos: ReadonlyArray<string> }
  | { readonly _tag: "unreadable"; readonly text: string }

/** `owner/name#12`, or `12` on its own. */
const spelled = /^(?:([^\s/]+\/[^\s/]+)#)?(\d+)$/

/**
 * The pull request a reference names.
 *
 * A reference that spells its repository out is taken as it is, registered or
 * not: reviewing someone else's pull request is a thing to ask for, and the
 * settings a repository nothing registered gets are the global defaults.
 */
export const resolve = (text: string, registered: ReadonlyArray<string>): Reference => {
  const found = spelled.exec(text)
  const number = found?.[2]
  if (number === undefined) {
    return { _tag: "unreadable", text }
  }

  const repo = found?.[1] ?? (registered.length === 1 ? registered[0] : undefined)
  if (repo === undefined) {
    return { _tag: "ambiguous", repos: registered }
  }
  return { _tag: "resolved", repo, number: Number(number) }
}
