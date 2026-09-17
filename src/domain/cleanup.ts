import { ByteSize } from "effect"

import type { Clone, Cutting, Inventory, Session } from "#adapters/store.ts"
import { sessionOf } from "#adapters/store.ts"

/** A checkout the tool cut for a session I steer, which stands until I take it down. */
export interface Standing extends Cutting {
  readonly session: Session
}

/** A clone that stays, and the session that is the reason. */
export interface Kept {
  readonly clone: Clone
  readonly because: string
}

/**
 * What `dw-mc cleanup` takes back, and what it leaves where it stands.
 *
 * The rule is one line: everything the tool can build again goes, and nothing
 * else is touched. A bare clone is a `git clone` away, and a review run's
 * worktree is cut fresh on every run, so both are the tool's own cost rather
 * than anything of mine. The records are not in here at all - what a pull
 * request is worth forgetting is decided when it is done, not by how much disk
 * it takes.
 */
export interface Plan {
  readonly clones: ReadonlyArray<Clone>
  readonly worktrees: ReadonlyArray<Cutting>
  readonly kept: ReadonlyArray<Kept>
  readonly size: ByteSize.ByteSize
}

/** The checkouts that stand for a session, named by the session they stand for. */
export const standing = (inventory: Inventory): ReadonlyArray<Standing> =>
  inventory.cuttings.flatMap((cutting) => {
    const session = sessionOf(cutting.cut)
    return session === undefined ? [] : [{ ...cutting, session }]
  })

/** The checkouts a review run cut, which no run that ended still needs. */
export const orphaned = (inventory: Inventory): ReadonlyArray<Cutting> =>
  inventory.cuttings.filter((cutting) => cutting.cut === "worktrees")

const sum = (sizes: ReadonlyArray<ByteSize.ByteSize>): ByteSize.ByteSize =>
  ByteSize.bytes(sizes.reduce((total, size) => total + ByteSize.toBigInt(size), BigInt(0)))

const reason = (sessions: ReadonlyArray<Standing>): string =>
  sessions
    .map((it) => `a ${it.session === "fix" ? "fix" : "resolve"} session stands on ${it.repo}#${it.number}`)
    .join(", ")

/**
 * What a cleanup would take, weighed.
 *
 * A clone whose repository has a session standing on it stays, and that is not
 * politeness: a standing worktree keeps its history inside the clone, so a
 * clone removed from under one leaves a directory of files with nothing behind
 * them. The worktrees of that session stay with it; the review run's own go
 * either way, because they belong to a run that has ended.
 */
export const plan = (inventory: Inventory): Plan => {
  const sessions = standing(inventory)
  const worktrees = orphaned(inventory)

  const held = new Map<string, ReadonlyArray<Standing>>()
  for (const session of sessions) {
    held.set(session.repo, [...(held.get(session.repo) ?? []), session])
  }

  const clones = inventory.clones.filter((clone) => !held.has(clone.repo))
  const kept = inventory.clones.flatMap((clone) => {
    const sessionsHere = held.get(clone.repo)
    return sessionsHere === undefined ? [] : [{ clone, because: reason(sessionsHere) }]
  })

  return {
    clones,
    worktrees,
    kept,
    size: sum([...clones, ...worktrees].map((it) => it.size))
  }
}

/** What the whole state directory weighs: the clones, the checkouts and the records. */
export const everything = (inventory: Inventory): ByteSize.ByteSize =>
  sum([...inventory.clones.map((it) => it.size), ...inventory.cuttings.map((it) => it.size), inventory.records.size])

/** Whether a plan has anything to do at all. */
export const empty = (it: Plan): boolean => it.clones.length === 0 && it.worktrees.length === 0

/** A size as a line says it: three digits at most, and the unit the terminal reads. */
export const weight = (size: ByteSize.ByteSize): string => ByteSize.format(size, { system: "decimal", precision: 1 })
