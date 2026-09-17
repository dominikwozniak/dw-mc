# anti-slop, vendored

Four Oxlint rules copied from [`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop) at commit
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` on `main`, dated 2026-09-10. There is no package to install and
the project is meant to be copied, so this directory is the installation. `v0.1.2`, the last tag, predates
the Effect rules and is not what to copy from.

## Theirs

Everything in this directory, under upstream's MIT licence (`LICENSE`).

Every path below is upstream's own path with the leading `src/` dropped, and each rule arrives with the
test beside it:

- `rules/no-chained-type-assertions.ts`
- `rules/no-module-mocking.ts`
- `rules/require-safety-comment-for-type-assertion.ts`
- `shared/scope.ts`, which `no-module-mocking` reads
- `effect/rules/prefer-effect-match.ts`

`index.ts` and `effect/index.ts` are upstream's entry points cut down to the rules taken: upstream registers
18 generic and 5 Effect rules, this repository takes 3 and 1. That is the only edit made to what was copied.

The tests are upstream's, unchanged. They are what makes a refresh verifiable rather than trusted, and they
run in this repository's own suite: `vitest.config.ts` includes `tools/oxlint/**/*.test.ts`, and
`tools/oxlint/rule-tester.setup.ts` hands oxlint's `RuleTester` the `describe` and `it` vitest does not put
on `globalThis`.

## Ours

`tools/oxlint/dw-mc/` — the `dw-mc` plugin and the `no-gh-writes` rule that holds ADR 0002. It is a plugin
of its own so that refreshing this directory never touches a file written here. **A refresh that takes
upstream's entry point wholesale drops it**, because upstream has no such rule to register.

`tools/oxlint/rule-tester.setup.ts` is ours as well.

## Rules not taken

The other 15 generic and 4 Effect rules are deliberately left. Measured against this tree, all 23 upstream
rules report 198 diagnostics, 171 of them from `require-readable-spacing` — work the formatter already owns,
and about 1,044 lines of vendored third-party formatting code to do it. Fourteen rules report nothing at all,
and most of what remains is a false positive on correct code. `no-service-constructor-imports` matches only
relative import specifiers, and ADR 0006 means there are none here, so it can never fire.

## Refreshing

1. Read this file, then upstream's own `skills/install-anti-slop/references/update.md`, which treats an
   update as a reviewed merge rather than a directory replacement. The base for that merge is the commit
   named above.
2. Take only the five rule files and `shared/scope.ts` listed above, with their tests. Adopting a rule
   upstream has added is a decision, not a consequence of the refresh.
3. Leave `index.ts` and `effect/index.ts` cut down, and leave `tools/oxlint/dw-mc/` alone.
4. `@oxlint/plugins` is pinned to the exact installed `oxlint` version in `package.json`. The two move
   together; the Effect oxlint patcher validates a version matrix and refuses on a mismatch.
5. Record the new commit here and run `pnpm check`.

This directory is excluded from lint, format and typecheck — one entry each in `.oxlintrc.json`,
`.oxfmtrc.json` and `tsconfig.json` — so upstream's own style is not this repository's problem on
every run. It is not excluded from the test suite, which is the point of keeping the tests.
