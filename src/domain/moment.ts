import { DateTime, Order, Predicate } from "effect"

/**
 * A moment something happened, or that it never did.
 *
 * Three of the facts a sweep reads are timestamps that a pull request may
 * simply not have - nobody has commented, nobody has pushed - and the rules
 * compare them all the same way. These are that comparison, in one place, over
 * `DateTime`'s own `Order` and `Equivalence`.
 */
export type Moment = DateTime.Utc | null

const isLater = Order.isGreaterThan(DateTime.Order)

/** Whether `self` happened after `other`, counting never as before anything. */
export const isAfter = (self: Moment, other: Moment): boolean =>
  Predicate.isNotNull(self) && (other === null || isLater(self, other))

/** The later of the two. */
export const later = (self: Moment, other: Moment): Moment => (isAfter(self, other) ? self : other)

/** Whether the two are the same moment, counting never as the same as never. */
export const isSame = (self: Moment, other: Moment): boolean =>
  self === null || other === null ? self === other : DateTime.Equivalence(self, other)

/** The latest of many, or never when there are none. */
export const newest = (moments: ReadonlyArray<DateTime.Utc>): Moment => moments.reduce<Moment>(later, null)
