# One `pnpm check` chain gates the repo, and oxlint carries the Effect diagnostics

`pnpm check` runs lint, format, typecheck, test and build. CI runs that one script, so a link added to the chain in `package.json` runs in CI without touching a workflow, and a ruleset on `main` requires the `Check` job. The pre-commit hook runs `lint-staged` alone: a hook that typechecks and tests is a hook people pass `--no-verify` to.

Linting is oxlint, because Effect's own monorepo lints with it and `@effect/tsgo` publishes the Effect rules as oxlint presets. `prepare` runs `effect-tsgo patch --oxlint`, which rewrites the installed oxlint binary to call the Effect TypeScript-Go engine and injects the `effecttsgo` namespace into oxlint's plugin enum; the config is invalid without it. The patcher validates a version matrix and refuses on a mismatch, so oxlint and oxlint-tsgolint are pinned exactly.

Effect diagnostics are reported by oxlint alone. The same findings are available from `tsc` through the language-service plugin and from `effect-tsgo diagnostics`, but the three are peers and only oxlint can fix them. `tsconfig.json` sets `"diagnostics": false` on the plugin so the editor does not report each finding twice; hover and the rest of the language service stay on.

Formatting is dprint, with the config lifted from `repos/effect/dprint.json`, because the source in `src/` is already written in that style. oxfmt targets Prettier and would rewrite every line of it.

`minimumReleaseAge` is three days rather than the week that would be stronger. `effect` ships a release candidate every few days and vitest 5 pulls the rolldown toolchain, so a week rejects 33 lockfile entries on an ordinary day and `minimumReleaseAgeExclude` stops being a list of decisions.

## Consequences

- Two keys in `.oxlintrc.json` are load-bearing and silent when wrong. `options.typeAware` is root-config-only, so an extended preset cannot supply it, and without it ~97 rules load, enable and do nothing. `plugins` at the root replaces the inherited set instead of merging, so `effecttsgo` is named there as well. A green run proves neither; the check is a floating `Effect` in a scratch file firing `effecttsgo/floating-effect`.
- The lint scripts pass `--disable-nested-config`. `repos/effect` carries its own `.oxlintrc.json` wiring a workspace-internal plugin that cannot resolve here, and oxlint loads nested configs before it applies ignore patterns.
- `categories` reaches past the preset: a rule in `correctness` or `suspicious` turns on even when `recommended.json` omits it. The Effect idioms that arrive that way are switched off by name, each with its reason.
- dprint exits non-zero when handed only files no plugin claims, which a lockfile-only commit does. `lint-staged` passes `--allow-no-files` and globs only the extensions dprint has a plugin for.
- `trustPolicy: no-downgrade` costs one standing exemption: `undici-types@6.21.0`, pinned by `@types/node@22.20.2`, shipped before that package published with provenance.
