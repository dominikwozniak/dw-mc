# Mission control

My local view of every open pull request I author: what each one waits on, which reviews have run against it, and the actions that move it forward. It runs on my machine, for me alone.

## Language

### Pull requests

**Tracked PR**:
An open pull request I authored that mission control follows.
_Avoid_: ticket, task, item

**Draft**:
A tracked PR that GitHub marks as a draft. Shown, never acted on unless I ask.

**Sweep**:
One pass over every tracked PR that refreshes what mission control knows about it. A sweep only reads.
_Avoid_: poll, refresh, sync

**Stamp**:
My local mark that a tracked PR has passed my own bar. Computed from review runs and CI, and I can withdraw it by hand. It lives only on this machine and is never a GitHub approval, label, comment or status.
_Avoid_: approval, label, status

### Buckets

**Bucket**:
The one place a tracked PR sits at a time, named for what it waits on. Every tracked PR is in exactly one.
_Avoid_: column, lane, status

**Needs me**:
The bucket for a PR only I can move: a conflict, red CI that is not flaky, changes requested, a human comment newer than my last activity, or a blocking finding.

**Needs review run**:
The bucket for a PR whose current head has no review run.

**Waiting on others**:
The bucket for a PR with nothing left for me: a human review is pending.

**Ready**:
The bucket for a PR that is approved, green and mergeable. Only my merge is left.

### Reviews

**Review run**:
One execution of a runner against a tracked PR at a specific head commit, recorded with its verdict and findings. GitHub's CI checks are not review runs.
_Avoid_: check, audit, scan

**Runner**:
A local agent CLI that a review run executes on. Claude Code is the primary runner; Codex is a supporting second opinion.
_Avoid_: reviewer, provider, model

**Finding**:
One problem a review run reports, at a file and line, with a severity of error, warning or info. An error is a blocking finding: it withholds the stamp until the head changes.
_Avoid_: issue, comment, violation

**Fix session**:
An interactive agent session mission control opens for me in a fresh worktree, carrying the findings I selected and my notes on them. It is never the review run that produced the findings; the re-review of its result is a new review run.
_Avoid_: auto-fix, repair run
