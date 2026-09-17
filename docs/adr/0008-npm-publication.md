# The CLI is published to npm as `dw-mc`, bundled by tsdown and released by changesets

Mission control is installed rather than cloned: `pnpm add -g dw-mc` puts one command on the machine. What is published is that command and nothing else. There is no `exports` map, no declaration file and no library surface, so every module under `src/` stays free to move and the only promise the package makes is the one the CLI makes at its own boundary. The name is unscoped, because it is also the word typed into the terminal, and npm has no aliases: one package, one name.

tsdown bundles the entry point into one executable file with a sourcemap beside it. Dependencies stay external. `effect` sits on a release candidate, and bundling it would freeze someone else's prerelease into this artifact, where an install could no longer move past it; external, a stable Effect 4 arrives through `pnpm update` instead of through a release of this tool. The version is stamped in at build time from `package.json`, so what `dw-mc --version` reports cannot drift from what the registry holds. Running from source leaves the constant undeclared rather than undefined, which is why the check for it is a `typeof`, and the fallback in `#cli/cli.ts` is what a test reads.

The version stays on `0.x` while Effect is on a release candidate. `1.0.0` promises that the commands and the shape of the state on disk will not move, and that is not a promise to make while the foundation is a prerelease.

changesets holds the version and the changelog, and nothing gates a pull request on carrying one: a changeset is the decision that something is worth releasing, not a condition of merging. A merge to `main` with changesets waiting opens a version pull request, and merging that one publishes. Publication goes over npm trusted publishing, so no token lives in the repository and every release carries provenance. It runs the whole `pnpm check` chain first, because [ADR 0005](./0005-quality-toolchain.md)'s gate deliberately skips the push a squash merge makes, and this is the one moment an artifact leaves the machine.

The package ships the bundle and `NOTICE.md`. The `/dw-mc` skill is not in it: it lives in this repository and installs from there through the `skills` CLI, and a copy in the tarball is a copy that can disagree with the original.

## Considered options

- Staying on `tsc -b`: rejected. It works, and it publishes sixty files, declaration files for a package nothing imports, and a runtime dependency on the `imports` map resolving correctly inside someone else's `node_modules`. One file has none of that.
- Bundling the dependencies into a zero-dependency CLI: rejected, and it is the version of this decision worth revisiting the day Effect 4 is stable. Today it would ship a pinned release candidate that only a release of this tool could move.
- Publishing under `@dominikwozniak/`: rejected. The scope buys a namespace this repository has no second package to fill, at the cost of an install command that no longer matches the command it installs.
- An `NPM_TOKEN` secret: rejected. `pnpm-workspace.yaml` sets `trustPolicy: no-downgrade`, so this repository already refuses dependencies that publish weaker than they used to; publishing without provenance would be asking of others what it does not do itself.

## Consequences

- The first `0.1.0` goes out by hand. npm binds a trusted publisher to a package that already exists, so the release workflow cannot make the release that makes it possible. Claiming the name with a throwaway version first would leave a version on the registry that can only ever be deprecated.
- The quality gate checks the tarball and not only the source: packed, installed into a clean directory and run. A file missing from `files`, a wrong `bin`, a lost execute bit and an import of a dependency that is not declared are all invisible to `pnpm check` and all fatal on the first install.
- `publint` and `are-the-types-wrong` have nothing to check here, because what they check — `exports`, the types that hang off it — is what this package deliberately does not have.
