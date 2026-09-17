# GitHub write boundary: my own branches, my own PR bodies, my own failed runs, nothing else

The reference loops post comments, resolve threads, apply labels and approve (qa-swarm, review-triage, StampHog). Mission control writes to GitHub in three ways only: pushing commits to a branch I author, editing the body of a PR I author, and re-running the failed jobs of a workflow run on a PR I author. It never comments, replies, resolves a thread, labels, reviews, approves, changes a status or merges. The review evidence and the stamp are for me; the team's PR surface stays human, and a bot on a team PR is the team's decision, not mine.

The three are the same write in different clothes: each one acts on my own work and leaves no mark anybody else has to read. A re-run spends CI minutes and changes a check's conclusion, which is why it is capped at one per head and asked for by hand rather than taken by a sweep.

## Consequences

- A repo that already runs comment-triggered reviewers (CodeRabbit, a `@claude-review` workflow) gets them observed, never triggered, because the trigger is a comment.
- The `code-review` marketplace plugin is out as a runner: it comments on the PR. The built-in `/code-review` is fine: it comments only with `--comment`, which the tool never passes.
- A sweep still only reads. Every write here belongs to a command I typed, so nothing the tool does on its own reaches GitHub.
