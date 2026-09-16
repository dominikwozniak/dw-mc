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
 * A segment of nothing but dots, which no repository is called.
 *
 * The repository names a directory under the state directory before it names
 * anything else, so `../x` would be a way out of it.
 */
const onlyDots = /^\.+$/

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

  const spelledRepo = found?.[1]
  if (spelledRepo !== undefined && spelledRepo.split("/").some((segment) => onlyDots.test(segment))) {
    return { _tag: "unreadable", text }
  }

  const repo = spelledRepo ?? (registered.length === 1 ? registered[0] : undefined)
  if (repo === undefined) {
    return { _tag: "ambiguous", repos: registered }
  }
  return { _tag: "resolved", repo, number: Number(number) }
}
