# dw-mc

## 0.2.0

### Minor Changes

- 8e0da73: `dw-mc comments <pr>` prints the conversation on a tracked pull request: by default what is newer than
  your last comment or commit, which is what puts the pull request in Needs me, and the whole of it under
  `--all`. Threads come from GraphQL, so a resolved or outdated one is left out rather than answered again.

### Patch Changes

- 6bb9b16: Releases are published from CI with a provenance attestation, so every version on the registry names the commit and the workflow that built it.
