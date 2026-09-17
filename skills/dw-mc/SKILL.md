---
name: dw-mc
description: Read mission control's state on my open pull requests from inside an agent session - which bucket a pull request sits in, what a review run found, whether it carries my stamp - and run the command that moves one forward. Use when I ask about my open PRs, a review run, its findings, my stamp, a rebase, a rebase conflict, a flaky CI or merging a pull request of mine.
---

# dw-mc

`dw-mc` is my local mission control: it keeps the state of my open pull requests on disk, reads GitHub through `gh`, and runs code reviews through local agent CLIs. This skill is a way into that state from a session I am already steering. It has no state of its own: every answer comes from running the CLI.

Use mission control's words: tracked PR, bucket, stamp, review run, finding, fix session, conflict record, resolve session, flaky failure, legitimate failure. They are defined in [`CONTEXT.md`](https://github.com/dominikwozniak/dw-mc/blob/main/CONTEXT.md), so a copy of this skill installed anywhere still reaches it.

## Reads

| I want                                                               | run                          |
| -------------------------------------------------------------------- | ---------------------------- |
| what every tracked PR waits on                                       | `dw-mc status`               |
| the same, without the table                                          | `dw-mc sweep`                |
| what the current review run found                                    | `dw-mc findings <pr>`        |
| those findings as the JSON a fix session is handed                   | `dw-mc findings <pr> --json` |
| whether a pull request carries my stamp, and what the stamp rests on | `dw-mc stamp <pr>`           |

`<pr>` is `28` where one repository is registered, and `owner/name#28` otherwise.

`dw-mc status` sweeps before it prints, so it costs a round of `gh` calls and is never stale. The other reads answer from what the last sweep wrote down; `dw-mc sweep` refreshes that.

## Writes

These change something, so run one only when I ask for it by name.

| I want                                      | run                           |
| ------------------------------------------- | ----------------------------- |
| a review run against the current head       | `dw-mc review <pr>`           |
| the stamp off, until the head changes       | `dw-mc stamp <pr> --withdraw` |
| the branch rebased onto its base and pushed | `dw-mc rebase <pr>`           |
| a flaky red CI run again, once              | `dw-mc rerun <pr>`            |
| a Ready, stamped pull request landed        | `dw-mc merge <pr>`            |

`dw-mc review` runs a model and takes minutes.

Three commands write to GitHub, and nothing else does.

`dw-mc rebase` and `dw-mc rerun` are ADR 0002's: a `--force-with-lease` push to a branch I author, and the failed jobs of a workflow run on a pull request I author. `dw-mc rerun` refuses a failure the classifier calls legitimate, and refuses a head it has already re-run, so running it on a red CI is never a way to hide one.

`dw-mc merge` is ADR 0008's, and it is the one no reflog of mine undoes: a squash merge that deletes the branch. It lands nothing that is not both Ready and stamped at the head it reads, and it refuses everything else with the command that earns the stamp. Run it only when I name the pull request and ask for it merged.

## Sessions

`dw-mc fix <pr>` and `dw-mc resolve <pr>` open an interactive session in a worktree. Do not run either from inside a session: you are already in one.

Run them with `--print` instead. That prints the prompt the session would have opened on - the findings I picked with their notes, or the conflicted files - and opens nothing. Work on that prompt here, in the checkout we are already in.

## What this skill never does

- It never opens the picker. `dw-mc` with no arguments wants a keyboard and a screen.
- It never writes to GitHub itself. No comment, review, label, approval or status, on any pull request (ADR 0002). The push, the re-run and the merge are the CLI's, not yours.
- It never retells findings from memory. Print them again rather than repeating what an earlier turn said they were.
