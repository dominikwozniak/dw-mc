# dw-mc

## 0.3.0

### Minor Changes

- c647a6a: `dw-mc status` gives every row's pull request reference the URL it opens at, so a terminal that follows
  OSC 8 links opens the pull request from the table. The text on the row is the reference it always was,
  and a pipe, a paste and a terminal that ignores the sequence read exactly what they read before.

### Patch Changes

- d7b37fe: `dw-mc cleanup` takes back the disk the tool spends on itself — the bare clones and the worktrees a
  review run left behind — and keeps your configuration, your records and the clone of any repository a
  `fix` or `resolve` session still stands on. `dw-mc uninstall` removes everything the tool wrote on the
  machine, takes the configuration file too with `--config`, and prints the one step it cannot take:
  removing the package. Both print what they would take with its weight and ask first, and neither
  touches a session worktree holding uncommitted changes or a commit the pull request's head does not
  have until `--force` says so.

## 0.2.0

### Minor Changes

- 8e0da73: `dw-mc comments <pr>` prints the conversation on a tracked pull request: by default what is newer than
  your last comment or commit, which is what puts the pull request in Needs me, and the whole of it under
  `--all`. Threads come from GraphQL, so a resolved or outdated one is left out rather than answered again.

### Patch Changes

- 6bb9b16: Releases are published from CI with a provenance attestation, so every version on the registry names the commit and the workflow that built it.
