# GitHub write boundary: pushes to my own branches and my PR bodies, nothing else

The reference loops post comments, resolve threads, apply labels and approve (qa-swarm, review-triage, StampHog). Mission control writes to GitHub in two ways only: pushing commits to a branch I author, and editing the body of a PR I author. It never comments, replies, resolves a thread, labels, reviews, approves, changes a status or merges. The review evidence and the stamp are for me; the team's PR surface stays human, and a bot on a team PR is the team's decision, not mine.

## Consequences

- A repo that already runs comment-triggered reviewers (CodeRabbit, a `@claude-review` workflow) gets them observed, never triggered, because the trigger is a comment.
- The `code-review` marketplace plugin is out as a runner: it comments on the PR. The built-in `/code-review` is fine: it comments only with `--comment`, which the tool never passes.
