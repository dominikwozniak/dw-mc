# Local-first: nothing leaves the machine but calls to GitHub and to local agent CLIs

The reference projects (Talyn, pr-shepherd) are services: a backend, webhooks, a GitHub App, agents on cloud VMs. Mission control is for me alone, so it is a CLI on my machine: state lives on disk, GitHub is reached only through `gh` as me, and agents run only as local CLIs (Claude Code, Codex). No server, no GitHub App, no webhooks, no cloud provider.

## Consequences

- Freshness is a sweep, never an event. Ten PRs polled every few minutes is far under the `gh` rate limit.
- No second machine and no other person ever sees the state.
