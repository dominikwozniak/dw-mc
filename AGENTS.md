# dw-mc

A local CLI that keeps the state of my open pull requests on disk, reads GitHub through `gh`, runs code reviews through local agent CLIs, and shows what every PR waits on.

`CONTEXT.md` is the glossary; use its terms verbatim. `docs/adr/` holds the decisions. `docs/v1-design.md` is the design the v1 build follows.

## Effect

`dw-mc` is TypeScript on Effect v4. Before writing any Effect code, read `node_modules/effect/AGENTS.md`
**completely** and follow its links into `node_modules/effect/ai-docs/`. For APIs and concepts that guide
does not cover, read the sources: `node_modules/effect/src` and `node_modules/@effect/platform-node/src`.

`repos/effect/` is a read-only checkout of the Effect monorepo for the few things npm leaves out; see
`repos/AGENTS.md`. Never import from it.

Commands: `pnpm typecheck`, `pnpm diagnostics` (Effect diagnostics through `@effect/tsgo`), `pnpm test`,
`pnpm build`.

## Agent skills

### Issue tracker

Issues live in the GitHub Issues of `dominikwozniak/dw-mc`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
