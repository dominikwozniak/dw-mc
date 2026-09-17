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

**Picker**:
The front door that covers the common loop without a flag: `dw-mc` with no arguments lists every tracked PR under the bucket it sits in, offers what can be done to the one I choose, and runs that command. A prompt and a table, never a full-screen TUI.
_Avoid_: menu, dashboard, TUI

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
The bucket for a PR whose current head has no review run from every deciding runner.

**Waiting on others**:
The bucket for a PR with nothing left for me: a human review is pending.

**Ready**:
The bucket for a PR that is approved, green and mergeable. Only my merge is left.

### Rebase

**Rebase**:
Bringing a tracked PR's branch up to date with its base: rebased onto the base and pushed with a lease, in a throwaway worktree. Off until a repository turns it on, and never while CI is running.
_Avoid_: update branch, sync, merge base

**Conflict record**:
What a rebase that conflicted wrote down: the head it happened at and the files it stopped on. It is scoped to that head, so a branch that moved is one nothing has tried to rebase yet, and it is what puts the PR in Needs me.
_Avoid_: conflict state, merge marker

**Resolve session**:
An interactive agent session mission control opens for me on a conflict record, in a worktree that stands on a branch of the tool's own and outlives the session. The rebase is redone there and left stopped on the conflict; finishing it, committing and pushing are mine. It is not a rebase: it writes nothing to GitHub.
_Avoid_: conflict fix, auto-merge

**Stack**:
Pull requests built on each other, where one's branch is another's base. Mission control recognises one, reports where a tracked PR sits in it, and never drives it.
_Avoid_: chain, train

### CI

**Flaky failure**:
A red CI that is not mine to fix, decided from three signals a sweep reads: the same workflow is red on the default branch, the failing log names a file the PR changes, and the log matches a known flaky pattern. No model is involved.
_Avoid_: intermittent, transient

**Legitimate failure**:
A red CI that is mine to fix. It is the answer whenever the evidence does not excuse the failure, so an unexplained red is mine. It is reported and never re-run.
_Avoid_: real, genuine

**CI re-run**:
Asking GitHub to run the failed jobs of a flaky failure again. One per head, so a job that fails twice at the same code is not flaky, and asked for by hand: a sweep only reads.
_Avoid_: retry, restart

### Reviews

**Review run**:
One execution of one runner against a tracked PR at a specific head commit, recorded with its verdict and findings. Every configured runner reviews in the one worktree, so a second opinion reads the same code. GitHub's CI checks are not review runs.
_Avoid_: check, audit, scan

**Runner**:
What a review run executes. `builtin` is Claude Code's own review command; `prompt` is the tool's own review prompt on Claude Code; `codex` is that same prompt on the Codex CLI. A repository configures one or more, and a head carries one run per runner.
_Avoid_: reviewer, provider, model

**Deciding runner**:
A configured runner whose findings are my bar: every configured runner but the supporting one, and every one of them where `stamp.supporting_blocks` is set. A head is reviewed once every deciding runner has reported on it.
_Avoid_: primary, blocking, real

**Supporting runner**:
A runner whose findings inform me without gating my bar: Codex, wherever a review of my own runs beside it. Its findings withhold no stamp until `stamp.supporting_blocks` says they may. Configured alone it is not supporting - it is the review.
_Avoid_: secondary, advisory, optional

**Launcher**:
The programs this machine starts a runner with, and the arguments they take before mission control's own. Their defaults are `claude` and `codex` themselves; a machine that reaches either through another program - `cswap run --`, a multi-account manager - names that program here. It carries the sessions I steer too - the one on findings and the one on a conflict - which are no review run.
_Avoid_: wrapper, executable, shim

**Finding**:
One problem a review run reports, at a file and line, with a severity of error, warning or info. A finding at or above `stamp.blocks_on`, an error unless I configure otherwise, is a blocking finding: it withholds the stamp until the head changes, unless a supporting runner found it.
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
