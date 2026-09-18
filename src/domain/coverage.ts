/** What I asked a sweep to cover: one repository by name, all of them, or neither. */
export interface Asked {
  readonly repo: string | undefined
  readonly all: boolean
}

/**
 * The registered repositories a sweep reads, and how many it leaves out, or
 * the sentence saying why it reads none.
 *
 * `leftOut` is what a narrowed table owes me a word about: a table of one
 * repository that said nothing of the rest would read as the whole picture.
 */
export type Coverage =
  | { readonly _tag: "covers"; readonly repos: ReadonlyArray<string>; readonly leftOut: number }
  | { readonly _tag: "refused"; readonly why: string }

const one = (repo: string, registered: ReadonlyArray<string>): Coverage => ({
  _tag: "covers",
  repos: [repo],
  leftOut: registered.length - 1
})

/**
 * The repositories a sweep covers.
 *
 * Standing in a registered repository is asking for that one, because that is
 * the table I want while I work there. Standing anywhere else asks for nothing
 * in particular, so it gets every registered repository, as it would have
 * before a sweep could be narrowed at all.
 *
 * `here` is the repository the working directory is in, and is only read when
 * neither flag decides.
 */
export const covered = (asked: Asked, here: string | undefined, registered: ReadonlyArray<string>): Coverage => {
  if (asked.repo !== undefined && asked.all) {
    return { _tag: "refused", why: "--repo names one repository and --all asks for every one. Pass one of them." }
  }
  if (asked.repo !== undefined) {
    if (registered.includes(asked.repo)) {
      return one(asked.repo, registered)
    }
    return {
      _tag: "refused",
      why:
        registered.length === 0
          ? `${asked.repo} is not registered. Run dw-mc init inside it to register it.`
          : `${asked.repo} is not registered. Name one of ${registered.join(", ")}, or run dw-mc init inside it.`
    }
  }
  if (!asked.all && here !== undefined && registered.includes(here)) {
    return one(here, registered)
  }
  return { _tag: "covers", repos: registered, leftOut: 0 }
}

/** Whether the working directory decides the coverage, which is the one case worth asking `gh` where it is. */
export const asksWhereIAm = (asked: Asked, registered: ReadonlyArray<string>): boolean =>
  asked.repo === undefined && !asked.all && registered.length > 0
