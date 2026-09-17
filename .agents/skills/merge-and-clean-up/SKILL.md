---
name: merge-and-clean-up
description: Land the pull request this session built and leave no scaffolding behind - wait for CI, squash-merge, then take the branch down here and on GitHub. Use whenever the user asks for a pull request merged, landed or shipped, and whenever they say "merge and clean up", "merge it", "zmerguj" or "wmerguj", even without naming the number.
---

Landing is one command; the rest is taking down what the branch needed while it was open. The order matters, because a squash merge deletes the branch on GitHub and nothing here brings back a commit that never left this machine.

## Land it

Read the pull request first, so what you merge is what you think you are merging:

```sh
git rev-parse --abbrev-ref HEAD
gh pr view --json number,title,state,mergeable,mergeStateStatus
```

Wait for the checks rather than merging into a red or an unfinished run. A squash merge is the one write no reflog of mine undoes, so nothing about it is worth guessing:

```sh
gh pr checks <n> --watch --interval 15
```

A failing check ends the skill: say which one failed and stop. The user asked for a merge, not for a merge at any cost.

```sh
gh pr merge <n> --squash --delete-branch
```

The squash subject is the pull request title, which is why the title follows the same `type(scope): subject` form as a commit.

**Expect this to print an error in a worktree and still have worked.** `gh` finishes by switching the local checkout to `main`, and `main` is checked out in the primary worktree, so it refuses with `fatal: 'main' is already used by worktree at ...`. That is the switch failing, not the merge. Confirm what actually happened instead of reading the exit code:

```sh
gh pr view <n> --json state,mergedAt
```

## Clean up

```sh
git fetch --prune
git switch --detach origin/main
git branch -D <the branch>
```

Detaching first is what makes the delete possible at all: the branch is checked out right here. Detaching onto `origin/main` also leaves the session standing on the commit that was just merged, which is where the next piece of work starts from.

`--prune` is what removes the remote-tracking ref that `--delete-branch` already deleted on GitHub. Where the remote branch survived - a protected branch, a merge queue - delete it by name rather than assuming.

Leave the worktree directory itself alone. It is the ground this session is standing on, and other sessions have their own; never delete, stash or revert a branch this session did not create.

## Report

One short block: the pull request and the commit it landed as, the issue it closed if it closed one, and anything that did not go as expected - a check that was skipped, a remote branch that survived. Then stop. Releasing is changesets' job on `main`, and it is not part of this.
