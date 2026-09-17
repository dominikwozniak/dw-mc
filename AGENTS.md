# dw-mc

A local CLI that keeps the state of my open pull requests on disk, reads GitHub through `gh`, runs code reviews through local agent CLIs, and shows what every PR waits on.

`CONTEXT.md` is the glossary; use its terms verbatim. `docs/adr/` holds the decisions. `docs/v1-design.md` is the design the v1 build follows.

## Effect

`dw-mc` is TypeScript on Effect v4. Before writing any Effect code, read `node_modules/effect/AGENTS.md`
**completely** and follow its links into `node_modules/effect/ai-docs/`. For APIs and concepts that guide
does not cover, read the sources: `node_modules/effect/src` and `node_modules/@effect/platform-node/src`.

`repos/effect/` is a read-only checkout of the Effect monorepo for the few things npm leaves out; see
`repos/AGENTS.md`. Never import from it.

## Source layout

Where a module goes, which way an import may cross a layer, and where its test and its fake live are
decided in [ADR 0006](docs/adr/0006-source-layout.md). Read it before adding a file to `src/`.

## Tooling

`pnpm` is the package manager, pinned in `package.json`. Never `npm`, `npx`, `yarn` or `bun`; run a
one-off tool with `pnpm dlx`, as in `pnpm dlx skills@latest add mattpocock/skills`.

`pnpm check` is the whole gate — `lint`, `format`, `typecheck`, `test`, `build` — and it is what CI runs.
The links are also single commands: `pnpm lint` / `pnpm lint:fix` (oxlint on the Effect engine, which is
where Effect diagnostics are reported), `pnpm format` / `pnpm format:fix` (oxfmt), `pnpm typecheck`,
`pnpm test`, `pnpm build`. See [ADR 0005](docs/adr/0005-quality-toolchain.md).

## Git conventions

A ticket is built on its own branch, in its own worktree under `.claude/worktree/<branch>`, and
lands on `main` through a pull request. Nothing is committed to `main` directly. The branch is named
`type/<issue>-subject`, as in `feat/2-three-test-seams`. (This is the development workflow; the
throwaway worktrees `CONTEXT.md` describes are what the tool itself cuts at runtime.)

Pull requests land as a **squash merge**. The squash subject is the pull request title, so the title
follows the same `type(scope): subject` form as a commit subject.

## Releases

The version in `package.json` is written by changesets and by nothing else. Never edit it, and never
publish from a machine: `main` publishes itself.

A change that someone installing `dw-mc` would notice carries a changeset, written in the same pull
request as the change it describes:

```sh
pnpm changeset
```

Pick `patch` for a fix, `minor` for a command, a flag or behaviour that is new, `major` for one that
breaks. The text is for whoever reads the changelog on npm, so it says what the tool now does, not which
files moved. A change nobody installing would notice — this file, an ADR, a workflow, a test — carries
none, and nothing complains: a changeset is the decision that something is worth releasing, not a
condition of merging.

What follows is automatic. A merge to `main` with changesets waiting opens a `chore(release): version
packages` pull request that bumps the version, writes `CHANGELOG.md` and consumes the changesets;
merging that one runs the gate, publishes to npm with provenance, tags the commit and cuts a GitHub
Release. See [ADR 0008](docs/adr/0008-npm-publication.md).

## Agent skills

### Issue tracker

Issues live in the GitHub Issues of `dominikwozniak/dw-mc`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Effect

The `## Effect` section above is what the `effect-ts` skill installs, pinned from `Effect-TS/skills` in
`skills-lock.json`. It is a bootstrap skill and it has already run; it carries no Effect knowledge, so
reach for it only when re-pinning the skill set, never while writing code. The knowledge lives in
`node_modules/effect/AGENTS.md`.
