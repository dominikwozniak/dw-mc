import { Console, Effect, Option } from "effect"
import type { Prompt } from "effect/unstable/cli"

import { readOrEmpty, settingsFor } from "#adapters/config.ts"
import { Paint, ink, plain } from "#adapters/paint.ts"
import { confirm, pick, width } from "#adapters/picker.ts"
import { prKey } from "#adapters/store.ts"
import { asUserError, userFacing } from "#cli/exit.ts"
import { cells, rule } from "#cli/row.ts"
import { everything, printTroubles, sweeping } from "#cli/sweep.ts"
import { table, truncate, visible } from "#cli/table.ts"
import type { Facts, Placed } from "#domain/bucket.ts"
import { group } from "#domain/bucket.ts"
import type { Offer, Standing } from "#domain/pick.ts"
import { actionsFor, argvFor } from "#domain/pick.ts"
import { rerunFor } from "#domain/rerun.ts"
import { stampedAmong } from "#domain/stamp.ts"
import type { Since } from "#domain/watermark.ts"
import { markShown, sinceShown } from "#domain/watermark.ts"

/** A title cut this short says nothing, so a row that tight loses the column instead. */
const shortest = 12

/** The cursor, the marker and the padding a prompt draws around every row of its list. */
const frame = 6

/**
 * How much of the screen a prompt leaves for the row itself.
 *
 * A row that wraps takes the whole list's alignment with it. Nothing is piping
 * into a prompt, so no screen to measure means the writing is going somewhere
 * that does not wrap either.
 *
 * A prompt counts the rows it has to erase from the length of what it drew,
 * and colour is length it never shows, so a coloured row has to be shorter by
 * exactly what the colour costs or the prompt erases a line above itself on
 * every keypress.
 */
const screenRoom = (screen: number, paint: Paint): number =>
  screen === 0 ? Number.POSITIVE_INFINITY : screen - frame - (paint === plain ? 0 : ink)

/**
 * One row of the list I pick a pull request from: its bucket, and then the row
 * `dw-mc status` gives it.
 *
 * The cells come from there rather than being built again here, so the list I
 * pick from and the table I read are the same rows with the bucket moved onto
 * each of them. A prompt has no headings to group under, so the bucket is named
 * on every row; the rows are still in the order the buckets are acted on. The
 * gutter in front says what moved since I last looked, as it does in the table.
 */
const cellsOf = ({ placed, stamped }: Standing, since: Since, room: number, paint: Paint): ReadonlyArray<string> =>
  cells(placed, stamped, since, room, paint, "named")

/**
 * Every tracked PR as something to pick, aligned down the whole list.
 *
 * The title is the one cell worth cutting, and then the one worth dropping. The
 * bucket and what the PR waits on are why I am looking at the list at all, and
 * the pull request is how I know which one I am picking; a commit subject I
 * have half of still tells me which pull request it is, and one cut to nothing
 * tells me less than the room it took. A screen too narrow for all four columns
 * loses the title's column rather than the reason's words.
 */
const choicesOf = (
  standings: ReadonlyArray<Standing>,
  sinceOf: (placed: Placed) => Since,
  screen: number,
  paint: Paint
): ReadonlyArray<Prompt.SelectChoice<Standing>> => {
  const measured = standings.map((it) => cellsOf(it, sinceOf(it.placed), Number.POSITIVE_INFINITY, paint))
  const widest = (index: number) => Math.max(...measured.map((row) => visible(row[index] ?? "")))
  const room = screenRoom(screen, paint) - (widest(0) + widest(1) + widest(3)) - rule.length * 3
  const told = room >= shortest

  const rows = table(
    standings.map((it) => {
      const row = cellsOf(it, sinceOf(it.placed), told ? room : 0, paint)
      return told ? row : [row[0] ?? "", row[1] ?? "", row[3] ?? ""]
    }),
    rule
  )
  return standings.map((standing, index) => ({
    title: truncate(rows[index] ?? "", screenRoom(screen, paint)),
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
 * Walking away at any prompt is an answer rather than a failure, and it leaves
 * nothing behind: nothing has been dispatched until every question is answered.
 * An action that carries its own question is asked it here, between the choice
 * and the dispatch, because the picker is where an action costs one keystroke
 * and a merge must never cost only that (ADR 0008).
 */
export const picker = <E, R>(dispatch: (argv: ReadonlyArray<string>) => Effect.Effect<void, E, R>) =>
  Effect.fn("pick")(
    function* () {
      const report = yield* sweeping(everything)

      if (report.repos.length === 0) {
        yield* Console.log("No repositories registered. Run dw-mc init inside a repository to register it.")
        return
      }

      const stamped = yield* stampedAmong(report.facts)
      const file = yield* readOrEmpty
      const standings = yield* Effect.forEach(
        group(report.facts).flatMap((grouped) => grouped.placed),
        Effect.fnUntraced(function* (placed) {
          return {
            placed,
            stamped: stamped.has(prKey(placed.facts.repo, placed.facts.number)),
            rebasing: settingsFor(file, placed.facts.repo).rebase.enabled,
            rerunAt: yield* rerunFor(placed.facts.repo, placed.facts.number)
          }
        })
      )

      yield* printTroubles(report.troubles)
      if (standings.length === 0) {
        yield* Console.log("No open pull requests.")
        return
      }

      const shown = standings.map((it) => it.placed)
      const choices = choicesOf(standings, yield* sinceShown(shown), yield* width, yield* Paint)
      // The list is on the screen from here, whatever I answer it with.
      yield* markShown(shown)
      const chosen = yield* pick("Which pull request?", choices)
      if (Option.isNone(chosen)) {
        return
      }

      const facts = chosen.value.placed.facts
      const offer = yield* pick(`What do I do with ${where(facts)}?`, actionChoices(actionsFor(chosen.value)))
      if (Option.isNone(offer)) {
        return
      }

      const question = offer.value.confirm
      if (question !== undefined && !(yield* confirm(question))) {
        yield* Console.log(`Nothing done to ${where(facts)}.`)
        return
      }

      yield* dispatch(argvFor(offer.value.action, facts))
    },
    Effect.catchTag(userFacing, asUserError)
  )
