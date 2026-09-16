# dw-mc

A local CLI that keeps the state of my open pull requests on disk, reads GitHub through `gh`, runs code reviews through local agent CLIs, and shows what every PR waits on.

`CONTEXT.md` is the glossary; use its terms verbatim. `docs/adr/` holds the decisions. `docs/v1-design.md` is the design the v1 build follows.

## Agent skills

### Issue tracker

Issues live in the GitHub Issues of `dominikwozniak/dw-mc`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
