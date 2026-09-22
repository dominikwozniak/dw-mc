# GitHub write boundary: my own branches, my own PR bodies, my own failed runs, nothing else

The reference loops post comments, resolve threads, apply labels and approve (qa-swarm, review-triage, StampHog). Mission control writes to GitHub in three ways only: pushing commits to a branch I author, editing the body of a PR I author, and re-running the failed jobs of a workflow run on a PR I author. It never comments, replies, resolves a thread, reviews, approves or changes a status. The review evidence and the stamp are for me; the team's PR surface stays human, and a bot on a team PR is the team's decision, not mine.

The three are the same write in different clothes: each one acts on my own work and leaves no mark anybody else has to read. v1 sends two of them - the PR body edit is admitted and unused - so a comment that counts the writes says two. A re-run spends CI minutes and changes a check's conclusion, which is why it is capped at one per head and asked for by hand rather than taken by a sweep.

Merging is not a fourth item here. It moves a shared branch and no reflog of mine brings it back, so it fails the half of the rule above that makes the three one rule; it is [ADR 0008](./0008-merging-my-own-pull-request.md), with a threshold of its own. The review label is not a fourth item either. It is a mark others read, on a surface we share, so it is [ADR 0012](./0012-labelling-my-own-pull-request.md), bound to my own pull requests and to a repository that asked for it. What this record bars, it bars on every pull request including mine.

## Consequences

- A repo that already runs comment-triggered reviewers (CodeRabbit, a `@claude-review` workflow) gets them observed, never triggered, because the trigger is a comment.
- The `code-review` marketplace plugin is out as a review command: it comments on the PR. The built-in `/code-review` is fine: it comments only with `--comment`, which the tool never passes.
- Every write here belongs to a command I typed. The one write a sweep makes is the review label of ADR 0012, on a repository that turned it on.
