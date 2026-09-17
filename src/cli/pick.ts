import { Console, Effect, Option } from "effect"
import type { Prompt } from "effect/unstable/cli"

import type { ConfigFile } from "#adapters/config.ts"
import { read as readConfig, settingsFor } from "#adapters/config.ts"
import { pick, width } from "#adapters/picker.ts"
import { prKey } from "#adapters/store.ts"
import { cells, heading, rule } from "#cli/row.ts"
import { asUserError, printTroubles, sweep, userFacing } from "#cli/sweep.ts"
import { table, truncate } from "#cli/table.ts"
import type { Facts } from "#domain/bucket.ts"
import { group } from "#domain/bucket.ts"
import type { Offer, Standing } from "#domain/pick.ts"
import { actionsFor, argvFor } from "#domain/pick.ts"
import { stampedAmong } from "#domain/stamp.ts"

/** A title cut this short says nothing, so a row that tight overflows instead. */
const shortest = 12

/** The cursor, the marker and the padding a prompt draws around every row of its list. */
const frame = 6

/**
 * How much of the screen a prompt leaves for the row itself.
 *
 * A row that wraps takes the whole list's alignment with it. Nothing is piping
 * into a prompt, so no screen to measure means the writing is going somewhere
 * that does not wrap either.
 */
const screenRoom = (screen: number): number => (screen === 0 ? Number.POSITIVE_INFINITY : screen - frame)

/**
 * One row of the list I pick a pull request from: its bucket, and then the row
 * `dw-mc status` gives it.
 *
 * The cells come from there rather than being built again here, so the list I
 * pick from and the table I read are the same rows with the bucket moved onto
 * each of them. A prompt has no headings to group under, so the bucket is said
 * on every row; the rows are still in the order the buckets are acted on.
 */
const cellsOf = ({ placed, stamped }: Standing, room: number): ReadonlyArray<string> => [
  heading[placed.placement.bucket],
  ...cells(placed, stamped, room)
]

/**
 * What is left for the title once every other cell has the width it needs.
 *
 * The title is the one cell worth cutting. The bucket and what the PR waits on
 * are why I am looking at the list at all, and the pull request is how I know
 * which one I am picking; a commit subject I have half of still tells me which
 * pull request it is.
 */
const titleRoom = (rows: ReadonlyArray<ReadonlyArray<string>>, screen: number): number => {
  const widest = (index: number) => Math.max(...rows.map((row) => (row[index] ?? "").length))
  const fixed = widest(0) + widest(1) + widest(3) + rule.length * 3
  return Math.max(screenRoom(screen) - fixed, shortest)
}

/** Every tracked PR as something to pick, aligned down the whole list. */
const choicesOf = (
  standings: ReadonlyArray<Standing>,
  screen: number
): ReadonlyArray<Prompt.SelectChoice<Standing>> => {
  const room = titleRoom(
    standings.map((it) => cellsOf(it, Number.POSITIVE_INFINITY)),
    screen
  )
  const rows = table(
    standings.map((it) => cellsOf(it, room)),
    rule
  )
  return standings.map((standing, index) => ({
    title: truncate(rows[index] ?? "", screenRoom(screen)),
    value: standing
  }))
}

const actionChoices = (offers: ReadonlyArray<Offer>): ReadonlyArray<Prompt.SelectChoice<Offer>> =>
  offers.map((offer) => ({ title: offer.title, value: offer }))

const where = (facts: Facts): string => `${facts.repo}#${facts.number}`

/**
 * The front door: pick a pull request, pick what to do with it, read the report.
 *
 * It sweeps first, every time, for the reason `dw-mc status` does: a list I
 * pick from is never one I forgot to refresh. What the sweep could not read is
 * said before the prompt opens, so a pull request missing from the list has its
 * explanation above it rather than after I have chosen.
 *
 * The picker runs nothing of its own. The action I choose is dispatched as the
 * arguments I would have typed, through the same parser and into the same
 * command, so there is one implementation of every action and the picker is
 * only a way of reaching it without remembering the flags.
 *
 * Walking away at either prompt is an answer rather than a failure, and it
 * leaves nothing behind: nothing has been dispatched until I have picked both.
 */
export const picker = <E, R>(dispatch: (argv: ReadonlyArray<string>) => Effect.Effect<void, E, R>) =>
  Effect.fn("pick")(
    function* () {
      const report = yield* sweep

      if (report.repos.length === 0) {
        yield* Console.log("No repositories registered. Run dw-mc init inside a repository to register it.")
        return
      }

      const stamped = yield* stampedAmong(report.facts)
      const file: ConfigFile = Option.getOrElse(yield* readConfig, (): ConfigFile => ({}))
      const standings = group(report.facts).flatMap((grouped) =>
        grouped.placed.map((placed): Standing => ({
          placed,
          stamped: stamped.has(prKey(placed.facts.repo, placed.facts.number)),
          rebasing: settingsFor(file, placed.facts.repo).rebase.enabled
        }))
      )

      yield* printTroubles(report.troubles)
      if (standings.length === 0) {
        yield* Console.log("No open pull requests.")
        return
      }

      const chosen = yield* pick("Which pull request?", choicesOf(standings, yield* width))
      if (Option.isNone(chosen)) {
        return
      }

      const facts = chosen.value.placed.facts
      const offer = yield* pick(`What do I do with ${where(facts)}?`, actionChoices(actionsFor(chosen.value)))
      if (Option.isNone(offer)) {
        return
      }

      yield* dispatch(argvFor(offer.value.action, facts))
    },
    Effect.catchTag(userFacing, asUserError)
  )
