# Commands

Every command, its flags, and what `--help` leaves out. The words are defined in [`CONTEXT.md`](../CONTEXT.md), and the configuration keys the flags override are in [`configuration.md`](./configuration.md).

## Naming a pull request

A command that takes `<pr>` accepts it in two forms:

- `owner/name#62` works from anywhere.
- `62` works while exactly one repository is registered. With more than one, the command asks for the full form.

## Which repositories a pass covers

`dw-mc sweep`, `dw-mc status` and the picker cover:

- the repository you stand in, when it is registered;
- every registered repository, when you stand anywhere else.

`--repo owner/name` narrows a pass to one registered repository, wherever you stand. `--all` widens it to every registered repository.

## `dw-mc`

Opens the picker. It sweeps, lists every tracked pull request with its bucket, and offers the actions that fit the one you choose. Keys: `↑↓` move, `enter` choose, `q` quit.

The picker runs nothing of its own. Every action is the command you would type, run through the same parser. Only the actions that apply are offered: `resolve` after a conflict, `rerun` on a flaky failure, `rebase` where `rebase.enabled` is on, `merge` on a Ready, stamped pull request. `merge` asks for confirmation first.

## `dw-mc init`

Sets up this machine and registers the repository you stand in. It asks nothing. On the first run it writes the built-in defaults under `defaults`. Inside a repository it adds that repository under `repos`. Run it again inside each repository you want tracked.

| Flag       | Value                                   | What it does                                                                          |
| ---------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| `--effort` | `low`, `medium`, `high`, `xhigh`, `max` | Writes `review.effort`.                                                               |
| `--base`   | branch name                             | Writes `base`: the branch pull requests target, over the default branch `gh` reports. |

Both write under `repos.<owner/name>` for the repository you stand in, or under `defaults` when you stand outside one.

## `dw-mc sweep`

Reads GitHub and updates the record of every tracked pull request in the pass. It writes nothing to GitHub.

| Flag     | Value        | What it does                                              |
| -------- | ------------ | --------------------------------------------------------- |
| `--repo` | `owner/name` | Covers this registered repository only, wherever you are. |
| `--all`  | —            | Covers every registered repository.                       |

## `dw-mc status`

Sweeps, then shows each tracked pull request under its bucket, with its stamp and what moved since you last looked.

| Flag     | Value        | What it does                                                                         |
| -------- | ------------ | ------------------------------------------------------------------------------------ |
| `--repo` | `owner/name` | Covers this registered repository only, wherever you are.                            |
| `--all`  | —            | Covers every registered repository.                                                  |
| `--json` | —            | Prints the pass as JSON, for `jq` or an agent session. Rows are not marked as shown. |

What a row carries:

| Mark                    | Meaning                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `+` in front            | A pull request you have not been shown before.                                  |
| `*` in front            | A pull request that moved since you last looked.                                |
| `●` `◐` `○` `◆`         | The bucket: Needs me, Needs review run, Waiting on others, Ready.               |
| `✓` after the reference | It carries your stamp.                                                          |
| `(draft)`               | The pull request is a draft.                                                    |
| `↳ … from <bucket>: …`  | Under a bucket heading: which pull request moved, from where, and what changed. |

`--json` prints one object:

```json
{
  "sweptAt": "2026-09-19T08:00:00.000Z",
  "repos": ["owner/name"],
  "leftOut": 0,
  "prs": [
    {
      "bucket": "needs-me",
      "reason": "2 blocking findings",
      "stamped": false,
      "since": { "_tag": "moved", "from": "needs-review-run", "what": ["0 → 2 blocking findings"] },
      "repo": "owner/name",
      "number": 71,
      "title": "feat(sweep): notice a head that moved under a run",
      "…": "every other fact the bucket rules read"
    }
  ],
  "troubles": [{ "where": "owner/name#65", "detail": "what could not be read" }]
}
```

`since._tag` is `new`, `still` or `moved`. `leftOut` counts the registered repositories this pass did not cover. `troubles` lists what the sweep could not read.

## `dw-mc comments <pr>`

Prints the conversation on a pull request and what in it waits on you. Resolved, outdated and answered threads are hidden by default.

| Flag    | Value | What it does                                                                                                              |
| ------- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| `--all` | —     | Prints the whole conversation, including resolved, outdated and answered threads.                                         |
| `--ack` | —     | Records that you read the conversation and nothing in it is yours to answer. The record stays local; GitHub sees nothing. |

## `dw-mc review <pr>`

Runs one review run with Claude Code in a throwaway worktree at the pull request's head. It ends with a bell and a macOS notification.

By default the run opens on `review.command` with `review.effort` after it, and carries `review.prompt` beside it. The flags override the configuration for this run only.

| Flag             | Value                                   | What it does                                                  |
| ---------------- | --------------------------------------- | ------------------------------------------------------------- |
| `--command`      | slash command                           | Opens the run on this command instead of `review.command`.    |
| `--prompt`       | text                                    | Carries these review instructions instead of `review.prompt`. |
| `--effort`       | `low`, `medium`, `high`, `xhigh`, `max` | Uses this effort instead of `review.effort`.                  |
| `--model`        | model id                                | Uses this model instead of `review.model`.                    |
| `--prompt-only`  | —                                       | Reviews on the prompt alone, without any slash command.       |
| `--command-only` | —                                       | Reviews on the slash command alone, without any prompt.       |
| `--force`        | —                                       | Runs even where the re-run rule would skip it.                |

`--prompt-only` cannot be combined with `--command`, and `--command-only` cannot be combined with `--prompt`.

The re-run rule skips a review when every file that changed since the last run matches `review.docs_only`.

```sh
dw-mc review 62 --effort high
dw-mc review 62 --prompt-only --prompt "Check the migration is reversible"
```

## `dw-mc findings <pr>`

Prints what the current review run found: file, line, severity and summary.

| Flag     | Value | What it does                                        |
| -------- | ----- | --------------------------------------------------- |
| `--json` | —     | Prints the findings as the JSON a fix session gets. |

```json
{
  "verdict": "findings",
  "findings": [{ "file": "src/cli/sweep.ts", "line": 120, "severity": "error", "summary": "…" }]
}
```

`verdict` is `clean` or `findings`. `severity` is `error`, `warning` or `info`.

## `dw-mc fix <pr>`

Lets you pick findings from the current review run, with an optional note on each. Then it opens an interactive Claude Code session on them in a worktree that stays after the session ends. It refuses when the head moved since the run.

| Flag       | Value | What it does                                                       |
| ---------- | ----- | ------------------------------------------------------------------ |
| `--commit` | —     | Lets this session commit what it changes, over `fix.commits`.      |
| `--print`  | —     | Prints the prompt the session would open on, and opens no session. |

## `dw-mc stamp <pr>`

Prints your stamp on a pull request and what it rests on.

| Flag         | Value | What it does                                                  |
| ------------ | ----- | ------------------------------------------------------------- |
| `--withdraw` | —     | Takes the stamp off this pull request until its head changes. |

## `dw-mc rebase <pr>`

Rebases the branch onto its base and pushes it with `--force-with-lease`. It runs only where `rebase.enabled` is `true`, and never while CI is running. A conflict aborts the rebase and is recorded for `dw-mc resolve`.

## `dw-mc resolve <pr>`

Opens a Claude Code session on the conflict that stopped a rebase, in a worktree that stays after the session ends. Finishing the rebase, committing and pushing are yours. `rebase.enabled` does not gate it, because it pushes nothing.

| Flag      | Value | What it does                                                       |
| --------- | ----- | ------------------------------------------------------------------ |
| `--print` | —     | Prints the prompt the session would open on, and opens no session. |

## `dw-mc rerun <pr>`

Runs the failed jobs of a flaky failure again, once per head. It refuses a legitimate failure and a head it has already re-run.

## `dw-mc merge <pr>`

Squash-merges a Ready pull request that carries your stamp, deletes its branch and forgets it. It refuses everything else.

## `dw-mc forget <pr>`

Forgets everything kept about a pull request that closed some other way.

## `dw-mc cleanup`

Removes the bare clones and the review worktrees a run left behind. Both are rebuilt on the next run. It keeps the configuration, every record, every fix or resolve worktree and the clone such a worktree uses. It shows what it will remove and asks first.

| Flag    | Value | What it does                                            |
| ------- | ----- | ------------------------------------------------------- |
| `--yes` | —     | Removes without asking, for a machine with no terminal. |

## `dw-mc uninstall`

Removes all the state `dw-mc` wrote on this machine and says how to remove the binary. It shows what it will remove and asks first.

| Flag       | Value | What it does                                                                                                             |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------ |
| `--config` | —     | Removes the configuration file too.                                                                                      |
| `--force`  | —     | Removes a fix or resolve worktree that still holds uncommitted changes or commits the pull request's head does not have. |
| `--yes`    | —     | Removes without asking, for a machine with no terminal.                                                                  |

## Global flags

Every command also takes `--help` (`-h`), `--version` (`-v`), `--log-level`, `--completions <bash|zsh|fish|sh>` and `--wizard`. `dw-mc --help` also prints where this machine's configuration and state live.

## Environment

| Variable          | Effect                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------- |
| `NO_COLOR`        | Any non-empty value turns colour off. Colour is also off when stdout is not a terminal. |
| `XDG_CONFIG_HOME` | Where `dw-mc/config.yaml` lives. Defaults to `~/.config`.                               |
| `XDG_STATE_HOME`  | Where `dw-mc/` state lives. Defaults to `~/.local/state`.                               |
