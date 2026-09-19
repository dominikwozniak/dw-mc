# Contributing

`dw-mc` is a tool one person uses every day, published so anyone else can. Bug reports, reproductions and small fixes are welcome; anything that changes what a command prints or what it writes to disk is worth an issue before a pull request.

## Before you start

Open an issue first for:

- a new command, or a new flag on one
- a change to the bucket rules, the stamp, or what `merge` accepts
- a change to the on-disk state or to `config.yaml`
- a new dependency

Straight to a pull request is fine for: a bug fix with a failing test, a documentation fix, a typo.

Two boundaries are settled and are not up for a pull request on their own:

- **Nothing leaves the machine** but calls to GitHub and to the local Claude Code — [ADR 0001](./docs/adr/0001-local-first.md).
- **What the tool may write to GitHub** is your own branches, your own pull request bodies, your own failed runs, and the squash merge of your own stamped pull request — [ADR 0002](./docs/adr/0002-github-write-boundary.md), [ADR 0008](./docs/adr/0008-merging-my-own-pull-request.md). It never comments, labels, reviews or approves.

## Setup

```sh
pnpm install
```

Node 24 or newer, and pnpm — the version is pinned in `package.json`. Never `npm`, `npx`, `yarn` or `bun`; run a one-off tool with `pnpm dlx`.

To run your working copy against real pull requests:

```sh
pnpm build
node dist/bin.js status
```

## The gate

```sh
pnpm check
```

That is the whole gate — `lint`, `format`, `typecheck`, `test`, `build` — and it is what CI runs, followed by a step that packs the tarball, installs it and runs the binary. Each link is also a command of its own:

| Command                           | What it runs                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm lint:fix`     | oxlint on the Effect engine, which is where the Effect diagnostics are reported |
| `pnpm format` / `pnpm format:fix` | oxfmt, over `.ts`, `.json`, `.md` and `.yaml` alike                             |
| `pnpm typecheck`                  | `tsc` over the project                                                          |
| `pnpm test`                       | vitest                                                                          |
| `pnpm build`                      | tsdown, to the single `dist/bin.js`                                             |

A commit hook formats what you staged, so a pull request never fails on whitespace alone. Formatting and import order belong to the formatter — never sort or align by hand.

## Writing the code

`dw-mc` is TypeScript on [Effect](https://effect.website) v4. Before writing Effect code, read `node_modules/effect/AGENTS.md` and follow its links into `node_modules/effect/ai-docs/`; for what the guide does not cover, read `node_modules/effect/src`.

Where a module goes, which way an import may cross a layer, and where its test and its fake live are decided in [ADR 0006](./docs/adr/0006-source-layout.md): `cli` → `domain` → `adapters` → `terms`, one direction only, no relative imports, a test beside the module it covers. Read it before adding a file to `src/`.

What a command may print — what colour says, what dim says, what is never coloured — is [ADR 0007](./docs/adr/0007-what-the-screen-says.md).

Every word this project uses in a particular way is defined in [`CONTEXT.md`](./CONTEXT.md). Use those terms verbatim, in code and in prose.

## Commits and branches

A change is built on its own branch, named `type/<issue>-subject`, as in `feat/2-three-test-seams`. Nothing is committed to `main` directly.

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`, lowercase, imperative. The body is short prose on _why_, never a list of files. One logical change per commit.

## Pull requests

Pull requests land as a squash merge, so the title is the subject of the commit that lands — it follows the same `type(scope): subject` form.

Fill in [the template](./.github/pull_request_template.md). It asks for what the change is and why, what was actually run, and what breaks if the change is wrong. A bug fix carries a regression test.

Add a changeset when the change is worth releasing:

```sh
pnpm changeset
```

A patch for a fix, a minor for a new command or flag. Nothing gates a pull request on carrying one — a changeset is the decision that something is worth releasing, not a condition of merging. [ADR 0011](./docs/adr/0011-npm-publication.md) has the rest of the release path.

## Decisions

A decision that outlives the pull request that made it goes in `docs/adr/`, numbered, rewritten in place when it changes. An ADR is a snapshot of what holds now, not a changelog of what it replaced.

## License

By contributing you agree that your contributions are licensed under the [MIT License](./LICENSE).
