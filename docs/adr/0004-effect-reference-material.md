# Effect is learned from `node_modules`, with the monorepo vendored as a read-only backstop

The `effect` package ships its own agent guide, its worked examples and its full TypeScript sources: `AGENTS.md` (409 lines), `ai-docs/**` and `src/**` are all listed in the package's `files` field. Whatever version `pnpm install` resolves, the reference material matches it exactly. That is the first stop, and `AGENTS.md` at the repo root points there.

The monorepo is vendored at `repos/effect` with `git subtree --squash` for the rest: `LLMS.md`, `MIGRATION.md`, the long-form `SCHEMA.md` and `HTTPAPI.md`, the changelog, and the packages outside core. It is reference only, listed in `repos/AGENTS.md`, never imported and never compiled — `tsconfig.json` includes `src` alone.

Effect is MIT, so it sits in the public repository without the licence problem that keeps the other reference trees in the private workshop ([ADR 0003](./0003-own-public-repository.md)). It costs 52 MB and one squashed commit.

## Considered options

- The monorepo as the primary source, as Effect's own "one weird git trick" article proposes: rejected. That article predates v4 shipping its docs and sources inside the package. Reading `repos/effect/packages/effect/src` instead of `node_modules/effect/src` risks reading a version the build does not use.
- No vendoring at all: rejected. `LLMS.md` and the migration guide are not published to npm, and `docs/v1-design.md` leans on the module map.
- A shallow clone outside the repository, as effect.solutions suggests: rejected. It is invisible to anyone who clones the repo, and it drifts without anything in the tree to say so.
