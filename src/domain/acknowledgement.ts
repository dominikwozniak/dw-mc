import type { DateTime } from "effect"
import { Effect, Option, Schema } from "effect"

import { prKey, remembered, storeFor } from "#adapters/store.ts"
import type { Moment } from "#domain/moment.ts"

/**
 * My word that I have read a pull request's conversation as far as one comment,
 * and that nothing in it is mine to answer.
 *
 * The comment's moment is the whole record, and no head is: everything else the
 * tool records is about code and lapses when the head changes, and this one is
 * about a conversation. A push is already counted as my answer to a comment, so
 * tying this to a head would only bring back a comment the push had nothing to
 * do with.
 */
export const Acknowledgement = Schema.Struct({ at: Schema.DateTimeUtcFromString })
export type Acknowledgement = typeof Acknowledgement.Type

/** The newest comment I have acknowledged on a pull request, or null where I have acknowledged none. */
export const acknowledgedAt = Effect.fn("acknowledgement.acknowledgedAt")(function* (repo: string, number: number) {
  const store = yield* storeFor("acknowledgements", Acknowledgement)
  const acknowledgement = yield* remembered(store.get(prKey(repo, number)))
  return Option.match(acknowledgement, { onNone: (): Moment => null, onSome: (it): Moment => it.at })
})

/** Records that I have read a pull request's conversation as far as the comment written at `at`. */
export const acknowledge = Effect.fn("acknowledgement.acknowledge")(function* (
  repo: string,
  number: number,
  at: DateTime.Utc
) {
  const store = yield* storeFor("acknowledgements", Acknowledgement)
  yield* store.set(prKey(repo, number), { at })
})
