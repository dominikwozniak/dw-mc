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
My local mark that a tracked PR has passed my own bar. Computed from review runs and CI, and I can withdraw it by hand, at the head I read, until that head changes. It lives only on this machine and is never a GitHub approval, label, comment or status.
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

### CI

**Flaky failure**:
A red CI that is not mine to fix, decided from three signals a sweep reads: the same workflow is red on the default branch, the failing log names a file the PR changes, and the log matches a known flaky pattern. No model is involved.
_Avoid_: intermittent, transient

**Legitimate failure**:
A red CI that is mine to fix. It is the answer whenever the evidence does not excuse the failure, so an unexplained red is mine.
_Avoid_: real, genuine

### Reviews

**Review run**:
One execution of a runner against a tracked PR at a specific head commit, recorded with its verdict and findings. GitHub's CI checks are not review runs.
_Avoid_: check, audit, scan

**Runner**:
A local agent CLI that a review run executes on. Claude Code is the primary runner; Codex is a supporting second opinion.
_Avoid_: reviewer, provider, model

**Launcher**:
The program this machine starts a runner with, and the arguments it takes before mission control's own. Its default is `claude` itself; a machine that reaches Claude Code through another program - `cswap run --`, a multi-account manager - names that program here. It carries the fix session too, which is no review run.
_Avoid_: wrapper, executable, shim

**Finding**:
One problem a review run reports, at a file and line, with a severity of error, warning or info. A finding at or above `stamp.blocks_on`, an error unless I configure otherwise, is a blocking finding: it withholds the stamp until the head changes.
_Avoid_: issue, comment, violation

**Outcome**:
What a review run came to: the verdict and findings it reported, or the failure it reached instead. Every recorded run has exactly one.
_Avoid_: result, status

**Failure**:
A review run that reached no verdict: the runner exited badly, ran out of patience, or answered in a shape that does not validate. Recorded as what it is, never as a clean verdict.
_Avoid_: error, crash

**Re-run rule**:
When a review run is repeated on a pull request that has already had one: only where files outside the repository's `docs_only` globs changed since that run. A force flag overrides it.
_Avoid_: cache, debounce

**Fix session**:
An interactive agent session mission control opens for me in a fresh worktree, carrying the findings I selected and my notes on them. The worktree stands on a branch of the tool's own that tracks the pull request's, and it outlives the session, because what I commit in it is mine. It is never the review run that produced the findings; the re-review of its result is a new review run.
_Avoid_: auto-fix, repair run

**Note**:
What I say about a finding when I pick it for a fix session. It is my word on the finding and outranks what the review run said about it.
