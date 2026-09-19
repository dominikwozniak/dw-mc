# Configuration

Every key `config.yaml` can hold, what it takes, and what it changes. The flags that override a key for one run are in [`cli.md`](./cli.md).

## Where things live

- Configuration: `$XDG_CONFIG_HOME/dw-mc/config.yaml`, or `~/.config/dw-mc/config.yaml`.
- State, including clones, worktrees, records and review reports: `$XDG_STATE_HOME/dw-mc`, or `~/.local/state/dw-mc`.

`dw-mc --help` prints both paths for this machine.

## How the file is read

- Every key is optional. A key the file leaves out keeps its inherited value.
- `defaults` applies to every registered repository. `repos.<owner/name>` takes the same keys and overrides `defaults` for that one repository. Setting a key to `null` there resets it.
- `dw-mc init` writes the file. It rewrites the whole file, so comments you add by hand do not survive it.
- A key this version does not know stops every command, with a message that names it. `dw-mc --help` still runs and prints the path to the file.

```yaml
launcher:
  command: [claude]
  fix_args: []
defaults:
  base: null
  review:
    command: /code-review
    effort: low
    prompt: null
    model: null
    docs_only: ["**/*.md", "docs/**"]
  ci:
    ignore: []
    flaky_patterns: []
  fix:
    commits: false
  rebase:
    enabled: false
  stamp:
    blocks_on: error
repos:
  owner/name:
    review:
      effort: high
```

## `launcher`

How this machine starts Claude Code. It exists only at the top level, never per repository.

| Key        | Values          | Default    | What it does                                                                                             |
| ---------- | --------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `command`  | list, not empty | `[claude]` | The program, then the arguments that go before `dw-mc`'s own. A list, never a shell string.              |
| `fix_args` | list            | `[]`       | Extra arguments for the sessions you steer: `dw-mc fix` and `dw-mc resolve`. Review runs never get them. |

## `base`

| Key    | Values              | Default | What it does                                                                  |
| ------ | ------------------- | ------- | ----------------------------------------------------------------------------- |
| `base` | branch name, `null` | `null`  | The branch pull requests target. `null` uses the default branch `gh` reports. |

## `review`

| Key         | Values                                          | Default                  | What it does                                                                                                                       |
| ----------- | ----------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `command`   | slash command, `null`                           | `/code-review`           | The slash command a review run opens on. `null` runs on the tool's own review prompt.                                              |
| `effort`    | `low`, `medium`, `high`, `xhigh`, `max`, `null` | `low`                    | The word written after `command`. `null` writes nothing after it.                                                                  |
| `prompt`    | text, `null`                                    | `null`                   | Your own review instructions. Beside a `command` they are added to the system prompt; without one they lead the tool's own prompt. |
| `model`     | model id, `null`                                | `null`                   | The model Claude Code runs the review on. `null` leaves it to Claude Code.                                                         |
| `docs_only` | list of globs                                   | `["**/*.md", "docs/**"]` | The re-run rule: when every file changed since the last run matches one of these, `dw-mc review` skips the run.                    |

`dw-mc review --command`, `--prompt`, `--effort` and `--model` override these keys for one run. `--force` runs past the re-run rule.

## `ci`

| Key              | Values          | Default | What it does                                                                                                                                                                     |
| ---------------- | --------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignore`         | list of names   | `[]`    | Check names that do not count towards green.                                                                                                                                     |
| `flaky_patterns` | list of strings | `[]`    | Text that marks a failure as flaky when a failed log contains it. Matched as case-insensitive substrings, not regular expressions. Added to the built-in list, not replacing it. |

The built-in patterns cover timeouts, dropped connections, lock timeouts, lost runners and exhausted resources. A log that names a file the pull request changes marks the failure as legitimate, whatever pattern it also matches.

## `fix`

| Key       | Values          | Default | What it does                                                                                                    |
| --------- | --------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `commits` | `true`, `false` | `false` | Whether a fix session may commit. `dw-mc fix --commit` allows it for one session. `dw-mc` itself never commits. |

## `rebase`

| Key       | Values          | Default | What it does                                                                                                   |
| --------- | --------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `enabled` | `true`, `false` | `false` | Whether `dw-mc rebase` may rebase and force-push this repository's branches. `dw-mc resolve` works either way. |

## `stamp`

| Key         | Values                     | Default | What it does                                                                                          |
| ----------- | -------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `blocks_on` | `error`, `warning`, `info` | `error` | The lowest severity that blocks. A finding at or above it withholds the stamp and counts as blocking. |
