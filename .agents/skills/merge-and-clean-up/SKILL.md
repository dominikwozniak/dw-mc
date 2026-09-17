---
name: merge-and-clean-up
description: Land the pull request this session built and leave no scaffolding behind - wait for CI, squash-merge, fast-forward local main onto what landed, then take the branch down here and on GitHub. Use whenever the user asks for a pull request merged, landed or shipped, whenever they name the merge/sync/clean-up loop, and whenever they say "merge and clean up", "merge it", "zmerguj" or "wmerguj", even without naming the number.
---

## Land it

```sh
gh pr view --json number,title,headRefName,state,mergeable,mergeStateStatus
gh pr checks <n> --watch --interval 15
gh pr merge <n> --squash --delete-branch
gh pr view <n> --json state,mergedAt
```

A failing check ends the skill: name it and stop.

In a worktree the merge lands and `gh` then fails to switch to `main` (`already used by worktree at ...`). The last command is the truth, not the exit code.

## Sync main

```sh
git fetch --prune
git worktree list
git -C <the worktree tagged [main]> merge --ff-only origin/main
```

`git fetch origin main:main` refuses while `main` is checked out, so it moves where it lives. `--ff-only` refuses on a diverged `main`, and over uncommitted changes it would touch - another session's work. A refusal ends the sync, not the skill: it goes in the report.

## Clean up

```sh
git switch --detach origin/main
git branch -D <headRefName>
```

Detach first - the branch is checked out right here. Leave the worktree directory alone.

## Report

The pull request, the commit it landed as, the issue it closed, where `main` points, anything refused. Releasing is changesets' job on `main`.
