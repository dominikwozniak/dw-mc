# dw-mc

Mission control for the pull requests you have open. `dw-mc` keeps what it knows about each one on disk, reads GitHub through your own `gh`, runs code reviews through the agent CLIs already installed on your machine, and sorts every pull request into the one bucket that says what it waits on. It is a local tool for one person: no server, no GitHub App, no webhooks, and nothing leaves the machine but the calls to GitHub it makes as you and whatever the agent CLIs send to their own providers.

## Requirements

- Node 24 or newer
- [`gh`](https://cli.github.com), authenticated: `gh auth login`
- `git`
- [Claude Code](https://claude.com/claude-code) as `claude`, or the [Codex CLI](https://developers.openai.com/codex/cli) as `codex` — at least one, for review runs and the sessions they open

## Install

```sh
pnpm add -g dw-mc
```

To look before installing, `pnpm dlx dw-mc --help` runs the same binary from a throwaway copy.

## Set up

```sh
dw-mc init
```

Run it once on the machine, and once more inside each repository whose pull requests you want followed. It asks which runner is your bar, whether Codex should give a second opinion beside it, and writes both answers to one file you can keep in your dotfiles.

## The day

```sh
dw-mc
```

With no arguments `dw-mc` opens the picker: every tracked pull request under the bucket it sits in, and the commands that move the one you choose. It is a prompt and a table, not a full-screen application, so what it runs is the command you would have typed.

The commands behind it, each usable on its own:

| Command               | What it does                                                                            |
| --------------------- | --------------------------------------------------------------------------------------- |
| `dw-mc sweep`         | Refreshes what mission control knows about every tracked pull request. It only reads.   |
| `dw-mc status`        | Shows which bucket every tracked pull request sits in, and which ones you have stamped. |
| `dw-mc review <pr>`   | Reviews one pull request on the configured runners, in a throwaway worktree.            |
| `dw-mc findings <pr>` | Prints what the current review run found.                                               |
| `dw-mc fix <pr>`      | Opens a session on the findings you pick, in a worktree that outlives it.               |
| `dw-mc stamp <pr>`    | Prints your stamp on a pull request, or withdraws it by hand.                           |
| `dw-mc rebase <pr>`   | Rebases a branch onto its base and pushes it with a lease.                              |
| `dw-mc resolve <pr>`  | Opens a session on the conflict that stopped a rebase.                                  |
| `dw-mc rerun <pr>`    | Runs a flaky red CI again, once per head.                                               |

A **bucket** is the one place a pull request sits at a time, named for what it waits on: _needs me_, _needs review run_, _waiting on others_, _ready_. A **stamp** is your own mark that a pull request has passed your bar — it lives on this machine and is never a GitHub approval. Every other word this tool uses is defined in [`CONTEXT.md`](./CONTEXT.md), and the decisions behind them in [`docs/adr/`](./docs/adr).

## Where things live

- Configuration: `$XDG_CONFIG_HOME/dw-mc/config.yaml`, or `~/.config/dw-mc/config.yaml`
- State: `$XDG_STATE_HOME/dw-mc`, or `~/.local/state/dw-mc`

The worktrees live under the state directory. A review run's is thrown away when the run ends; the one a fix or resolve session opens is left standing, on a branch of the tool's own, because the work you commit in it is yours.

## The skill

An agent session can reach mission control's state through the `/dw-mc` skill, which lives in this repository and calls the CLI and nothing else:

```sh
pnpm dlx skills@latest add dominikwozniak/dw-mc
```

## Licence

MIT. Third-party notices are in [`NOTICE.md`](./NOTICE.md).
