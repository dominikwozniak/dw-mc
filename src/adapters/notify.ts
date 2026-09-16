import { Effect, Terminal } from "effect"

import { capture } from "#adapters/spawner.ts"

/** A string as AppleScript spells one, so a quotation mark cannot end it early. */
const quoted = (text: string): string => `"${text.replaceAll("\\", "\\\\").replaceAll(`"`, `\\"`)}"`

/**
 * Says a foreground run has ended, twice: the bell for the terminal I left, and
 * a desktop notification for the window I went to instead.
 *
 * A review run takes minutes, and the whole point of it running in the
 * foreground is that I go and do something else while it does. Neither half is
 * worth failing a finished run over: `osascript` is macOS's, and a machine
 * without it still finished the review.
 */
export const announce = Effect.fn("notify.announce")(function* (title: string, message: string) {
  const terminal = yield* Terminal.Terminal
  yield* Effect.ignore(terminal.display("\u0007"))
  yield* Effect.ignore(
    capture("osascript", ["-e", `display notification ${quoted(message)} with title ${quoted(title)}`])
  )
})
