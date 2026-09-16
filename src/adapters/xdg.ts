import { Config, Effect, Option, Path } from "effect"

/**
 * One of `dw-mc`'s XDG base directories: `$<variable>/dw-mc` where the
 * environment sets `variable`, and `$HOME/<fallback>/dw-mc` where it does not.
 */
export const xdgDirectory = Effect.fnUntraced(function*(
  variable: string,
  ...fallback: ReadonlyArray<string>
) {
  const path = yield* Path.Path
  const configured = yield* Config.String(variable).pipe(Config.option)
  const home = Option.isSome(configured)
    ? configured.value
    : path.join(yield* Config.String("HOME"), ...fallback)
  return path.join(home, "dw-mc")
})
