---
name: dw-mc
description: Mission control on my open pull requests, read from inside a session I already steer - which bucket a PR sits in, what its review run found, what its conversation waits on me for, whether it carries my stamp - and the command that moves one forward. Use when I ask about my open PRs, a review run or its findings, a pull request's comments or threads, my stamp, a rebase or the conflict that stopped one, a flaky CI, or merging a pull request of mine.
---

# dw-mc

`dw-mc` is my local mission control: it keeps the state of my open pull requests on disk, reads GitHub through `gh`, and runs code reviews through local agent CLIs. This skill is a way into that state from a session I am already steering. It has no state of its own: every answer comes from running the CLI.

Use mission control's words: tracked PR, bucket, stamp, review run, finding, fix session, conflict record, resolve session, flaky failure, legitimate failure. They are defined in [`CONTEXT.md`](https://github.com/dominikwozniak/dw-mc/blob/main/CONTEXT.md), so a copy of this skill installed anywhere still reaches it.

Every command here names the pull request it acts on, because `dw-mc` with no arguments opens the picker, and the picker wants a keyboard and a screen. The flags each command takes beyond the ones below are in `dw-mc <command> --help`.

## Reads

| I want                                                               | run                                     |
| -------------------------------------------------------------------- | --------------------------------------- |
| what every tracked PR waits on                                       | `dw-mc status`                          |
| what mission control knows refreshed, and no table                   | `dw-mc sweep`                           |
| the conversation on a pull request, and what in it waits on me       | `dw-mc comments <pr>`                   |
| the whole conversation, resolved and answered threads included       | `dw-mc comments <pr> --all`             |
| what the current review run found                                    | `dw-mc findings <pr>`                   |
| what one runner found, over the first the repository configured      | `dw-mc findings <pr> --runner <runner>` |
| those findings as the JSON a fix session is handed                   | `dw-mc findings <pr> --json`            |
| whether a pull request carries my stamp, and what the stamp rests on | `dw-mc stamp <pr>`                      |

`<pr>` is `28` where one repository is registered, and `owner/name#28` otherwise. `<runner>` is `builtin`, `prompt` or `codex`.

`dw-mc status` sweeps before it prints, so it costs a round of `gh` calls and is never stale. The other reads answer from what the last sweep wrote down; `dw-mc sweep` refreshes that and prints what it swept.

Print findings again in the turn that needs them. The printed run is the state; what an earlier turn said about it is a copy, and a review run at a newer head replaces it.

## Writes

These change something, so run one only when I ask for it by name.

| I want                                                 | run                               |
| ------------------------------------------------------ | --------------------------------- |
| a review run against the current head                  | `dw-mc review <pr>`               |
| that run where the re-run rule would skip it           | `dw-mc review <pr> --force`       |
| that run at a chosen effort, over the configured one   | `dw-mc review <pr> --effort high` |
| the stamp off, until the head changes                  | `dw-mc stamp <pr> --withdraw`     |
| the branch rebased onto its base and pushed            | `dw-mc rebase <pr>`               |
| a flaky red CI run again, once                         | `dw-mc rerun <pr>`                |
| a Ready, stamped pull request landed                   | `dw-mc merge <pr>`                |
| this machine set up and the repository I am in tracked | `dw-mc init`                      |

`dw-mc review` runs a model and takes minutes.

`dw-mc init` is what "No repositories registered" asks for. It writes my config on this machine and reaches nothing else.

`dw-mc rebase`, `dw-mc rerun` and `dw-mc merge` are the three commands that write to GitHub, and the CLI owns all three: run them as they are, and leave every write of my own - comment, review, label, approval, status - unmade (ADR 0002).

`dw-mc rebase` and `dw-mc rerun` stay inside that boundary: a `--force-with-lease` push to a branch I author, and the failed jobs of a workflow run on a pull request I author. `dw-mc rerun` refuses a failure the classifier calls legitimate, and refuses a head it has already re-run, so running it on a red CI is never a way to hide one.

`dw-mc merge` is ADR 0008's, and it is the one no reflog of mine undoes: a squash merge that deletes the branch. It lands nothing that is not both Ready and stamped at the head it reads, and it refuses everything else with the command that earns the stamp. Run it only when I name the pull request and ask for it merged.

## Sessions

`dw-mc fix <pr>` and `dw-mc resolve <pr>` open an interactive session in a worktree. Do not run either from inside a session: you are already in one.

Run them with `--print` instead. That prints the prompt the session would have opened on - the findings I picked with their notes, or the conflicted files - and opens nothing. Work on that prompt here, in the checkout we are already in.
