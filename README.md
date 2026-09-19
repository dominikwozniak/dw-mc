# dw-mc

**Mission control for the pull requests you have open** — one bucket per PR, reviewed by the agent CLIs already on your machine.

[![npm](https://img.shields.io/npm/v/dw-mc.svg?color=0b7285)](https://www.npmjs.com/package/dw-mc)
[![CI](https://github.com/dominikwozniak/dw-mc/actions/workflows/quality-gate.yaml/badge.svg)](https://github.com/dominikwozniak/dw-mc/actions/workflows/quality-gate.yaml)
[![license](https://img.shields.io/npm/l/dw-mc.svg?color=0b7285)](./LICENSE)
[![node](https://img.shields.io/node/v/dw-mc.svg?color=0b7285)](https://nodejs.org)

`dw-mc` keeps what it knows about each of your open pull requests on disk, reads GitHub through your own `gh`, runs code reviews through your local Claude Code, and sorts every pull request into the one bucket that says what it waits on.

- **One bucket per pull request** — _needs me_, _needs review run_, _waiting on others_, _ready_. Never two at once.
- **Reviews on the Claude Code you already have** — its own `/code-review`, your own review brief, or both at once.
- **Nothing leaves the machine** — no server, no GitHub App, no webhooks. Only the GitHub calls you would have made yourself, and whatever Claude Code sends Anthropic.
- **State in plain files** — JSON and Markdown under XDG paths, readable without the tool.
- **A prompt, not a TUI** — the picker runs the command you would have typed, so nothing it does is hidden from you.

```
$ dw-mc status

Needs me
  ↳ dominikwozniak/dw-mc#71 from Needs review run: 0 → 2 blocking findings
* ● dominikwozniak/dw-mc#71   │ feat(sweep): notice a head that moved under a run   │ 2 blocking findings

Needs review run
  ◐ dominikwozniak/dw-mc#65   │ docs(agents): how a change becomes a release        │ no review run on this head
  ◐ dominikwozniak/dw-mc#66   │ docs(skill): the CLI surface the skill actually has │ no review run on this head

Waiting on others
+ ○ dominikwozniak/dw-mc#68   │ fix(rebase): keep the lease on a head that moved    │ CI is still running

Ready
  ◆ dominikwozniak/dw-mc#62 ✓ │ feat(comments): read a pull request's threads       │ approved, green, mergeable
```

## Install

```sh
pnpm add -g dw-mc
```

To look before installing, `pnpm dlx dw-mc --help` runs the same binary from a throwaway copy.

### Requirements

- Node 24 or newer
- [`gh`](https://cli.github.com), authenticated: `gh auth login`
- `git`
- [Claude Code](https://claude.com/claude-code) as `claude`, for review runs and the sessions they open

## Quick start

```sh
dw-mc init      # once on the machine, then once inside each repository you want followed
dw-mc           # the picker: every tracked PR under its bucket, and the commands that move it
dw-mc review 62 # or drive any command straight
```

`init` asks nothing: it writes the defaults to one file you can keep in your dotfiles, and what a review opens on is two keys in it — `review.command` and `review.prompt`.

Every command that takes a pull request takes it as `62` inside the repository, or as `owner/name#62` from anywhere.

## Commands

| Command               | Flags                                                                                        | What it does                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `dw-mc`               | —                                                                                            | Opens the picker: every tracked pull request under its bucket, and what moves the one you choose.          |
| `dw-mc init`          | `--effort`, `--base`                                                                         | Sets this machine up and registers the repository you are in.                                              |
| `dw-mc sweep`         | —                                                                                            | Refreshes what mission control knows about every tracked pull request. It only reads.                      |
| `dw-mc status`        | `--json`                                                                                     | Shows which bucket every tracked pull request sits in, which ones you have stamped, and what moved.        |
| `dw-mc comments <pr>` | `--all`, `--ack`                                                                             | Prints the conversation on a pull request, and with `--ack` records that nothing in it is yours to answer. |
| `dw-mc review <pr>`   | `--command`, `--prompt`, `--effort`, `--model`, `--prompt-only`, `--command-only`, `--force` | Reviews one pull request on Claude Code, in a throwaway worktree.                                          |
| `dw-mc findings <pr>` | `--json`                                                                                     | Prints what the current review run found.                                                                  |
| `dw-mc fix <pr>`      | `--print`, `--commit`                                                                        | Opens a session on the findings you pick, in a worktree that outlives it.                                  |
| `dw-mc stamp <pr>`    | `--withdraw`                                                                                 | Prints your stamp on a pull request, or withdraws it by hand.                                              |
| `dw-mc rebase <pr>`   | —                                                                                            | Rebases a branch onto its base and pushes it with a lease.                                                 |
| `dw-mc resolve <pr>`  | `--print`                                                                                    | Opens a session on the conflict that stopped a rebase.                                                     |
| `dw-mc rerun <pr>`    | —                                                                                            | Runs a flaky red CI again, once per head.                                                                  |
| `dw-mc merge <pr>`    | —                                                                                            | Squash-merges a Ready, stamped pull request of yours, deletes its branch and forgets it.                   |
| `dw-mc forget <pr>`   | —                                                                                            | Forgets everything kept about a pull request that closed another way.                                      |
| `dw-mc cleanup`       | `--yes`                                                                                      | Takes back the disk spent on clones and review worktrees, and keeps everything you decided.                |
| `dw-mc uninstall`     | `--config`, `--force`, `--yes`                                                               | Removes everything the tool wrote on this machine, and says how to remove the binary.                      |

`dw-mc <command> --help` prints the flags and what each one is worth.

## How it works

A **bucket** is the one place a pull request sits at a time, named for what it waits on. The rules are tried in order and the first that claims the pull request wins, so a pull request that both needs a review run and has changes requested is yours to move, not the review's.

| Bucket            | Marker | It waits on                                                                             |
| ----------------- | ------ | --------------------------------------------------------------------------------------- |
| Needs me          | `●`    | You: blocking findings, changes requested, a conflict, a red CI, an unanswered comment. |
| Needs review run  | `◐`    | A review run on this head.                                                              |
| Waiting on others | `○`    | A reviewer who has not answered, or CI that is still running.                           |
| Ready             | `◆`    | Nothing.                                                                                |

A **stamp** is your own mark that a pull request has passed your bar. It lives on this machine and is never a GitHub approval — but `dw-mc merge` reads it, so a pull request you have not stamped does not merge.

A review run works in a worktree that is thrown away when the run ends. The worktree a `fix` or `resolve` session opens is left standing, on a branch of the tool's own, because the work you commit in it is yours.

Every other word this tool uses is defined in [`CONTEXT.md`](./CONTEXT.md), and the decisions behind them in [`docs/adr/`](./docs/adr).

## Configuration

- Configuration: `$XDG_CONFIG_HOME/dw-mc/config.yaml`, or `~/.config/dw-mc/config.yaml`
- State, including the worktrees: `$XDG_STATE_HOME/dw-mc`, or `~/.local/state/dw-mc`

`init` writes the file, and every key in it is optional: what it leaves out is inherited rather than reset, and `repos` overrides `defaults` in the same shape.

```yaml
launcher:
  command: [claude] # program + argument prefix that starts Claude Code
  fix_args: [] # flags only a fix session gets
defaults:
  base: null # the default branch from gh when null
  review:
    command: /code-review # the slash command a run opens on; null for none
    effort: low # the word after the command: low | medium | high | xhigh | max
    prompt: null # your own review brief
    model: null
    docs_only: ["**/*.md", "docs/**"]
  ci:
    ignore: [] # check names that do not count towards green
    flaky_patterns: []
  fix:
    commits: false # whether a fix session may commit; --commit overrides it
  rebase:
    enabled: false
  stamp:
    blocks_on: error
repos:
  owner/name:
    # the same keys, overriding defaults
```

## Taking it back

Removing the package removes the binary and nothing else — a package manager runs no uninstall script, so the two directories above would stay where they are. The tool takes them back itself.

```sh
dw-mc cleanup   # the bare clones and the worktrees a review run left: disk the tool spends on itself
dw-mc uninstall # every record, report, clone and worktree
pnpm remove -g dw-mc
```

Both print what they would take, with its weight, and ask before taking it; `--yes` answers for a machine with no terminal. `cleanup` keeps your configuration and every record, and keeps the clone of a repository a `fix` or `resolve` session still stands on, because that session's history lives inside it. `uninstall` keeps the configuration file too unless `--config` asks for it. A worktree a `fix` or `resolve` session left standing is yours: `cleanup` never touches one, and `uninstall` names what it still holds — uncommitted changes, or a commit your pull request's head does not have — and removes nothing until `--force`.

Neither forgets a pull request's records; being done is what does that. `dw-mc merge` forgets the pull request it merged, and `dw-mc forget <pr>` forgets one that closed another way. A sweep never forgets anything, because a pull request missing from one search is not one that is gone. A `fix` or `resolve` session's worktree survives both, and is named.

## The skill

An agent session can reach mission control's state through the `/dw-mc` skill, which lives in this repository and calls the CLI and nothing else:

```sh
pnpm dlx skills@latest add dominikwozniak/dw-mc
```

## Contributing

```sh
pnpm install
pnpm check # lint, format, typecheck, test, build — the whole gate, and what CI runs
```

Work lands on `main` through a pull request, on a branch named `type/<issue>-subject`, squash-merged under a [Conventional Commits](https://www.conventionalcommits.org) title. [`CONTRIBUTING.md`](./CONTRIBUTING.md) has the rest: what is worth an issue first, the layers a module belongs to, and when a change carries a changeset. Everyone taking part is held to the [Code of Conduct](./CODE_OF_CONDUCT.md).

Found a security issue? Do not open an issue — [`SECURITY.md`](./SECURITY.md) says how to report it privately.

## License

MIT. Third-party notices are in [`NOTICE.md`](./NOTICE.md).
