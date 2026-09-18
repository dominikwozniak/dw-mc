# Mission control

My local view of every open pull request I author: what each one waits on, which reviews have run against it, and the actions that move it forward. It runs on my machine, for me alone.

## Language

### Pull requests

**Tracked PR**:
An open pull request I authored that mission control follows.
_Avoid_: ticket, task, item

**Draft**:
A tracked PR that GitHub marks as a draft. Shown, never acted on unless I ask.

**Conversation**:
Everything said on a tracked PR: its own comments, the bodies of its reviews, and every thread on its diff. Mission control reads it and never writes to it.
_Avoid_: discussion, feedback

**Thread**:
One strand of a conversation: a review thread on a line of the diff, or the pull request's own comments, which hang off no path. A thread somebody resolved and one against code that is gone are settled - read on request, never counted as waiting on me.
_Avoid_: discussion, note

**Sweep**:
One pass over every tracked PR that refreshes what mission control knows about it. A sweep only reads.
_Avoid_: poll, refresh, sync

**Picker**:
The front door that covers the common loop without a flag: `dw-mc` with no arguments lists every tracked PR under the bucket it sits in, offers what can be done to the one I choose, and runs that command. A prompt and a table, never a full-screen TUI.
_Avoid_: menu, dashboard, TUI

**Stamp**:
My local mark that a tracked PR has passed my own bar. Computed from review runs and CI, and I can withdraw it by hand, at the head I read, until that head changes. It lives only on this machine and is never a GitHub approval, label, comment or status.
_Avoid_: approval, label, status

**Merge**:
Landing a tracked PR of mine: squashed, with its branch deleted, on a PR that is both Ready and stamped at the head the command reads. The one write no reflog of mine undoes, so it is never taken by a sweep and never one keystroke in the picker.
_Avoid_: ship, close, auto-merge

### Buckets

**Bucket**:
The one place a tracked PR sits at a time, named for what it waits on. Every tracked PR is in exactly one.
_Avoid_: column, lane, status

**Needs me**:
The bucket for a PR only I can move: a conflict, red CI that is not flaky, changes requested, a human comment newer than my last activity, or a blocking finding.

**Needs review run**:
The bucket for a PR whose current head has no review run behind it.

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
One review of a tracked PR at a specific head commit, recorded with its verdict and findings. It runs in a throwaway worktree cut at that head, and a head carries one. GitHub's CI checks are not review runs.
_Avoid_: check, audit, scan

**Review turn**:
What a review run opens on: the slash command `review.command` names with `review.effort` after it, my own instructions from `review.prompt`, or both. A slash command is the review, so it takes two turns - the review, then the same review asked for as findings - and my instructions ride beside it on the system prompt. Without one the review is the tool's own persona with my instructions in front of it, in a single turn.
_Avoid_: runner, invocation, mode

**Launcher**:
The program this machine starts Claude Code with, and the arguments it takes before mission control's own. Its default is `claude` itself; a machine that reaches it through another program - `cswap run --`, a multi-account manager - names that program here. It carries the sessions I steer too - the one on findings and the one on a conflict - which are no review run.
_Avoid_: wrapper, executable, shim

**Finding**:
One problem a review run reports, at a file and line, with a severity of error, warning or info. A finding at or above `stamp.blocks_on`, an error unless I configure otherwise, is a blocking finding: it withholds the stamp until the head changes.
_Avoid_: issue, comment, violation

**Outcome**:
What a review run came to: the verdict and findings it reported, or the failure it reached instead. Every recorded run has exactly one.
_Avoid_: result, status

**Failure**:
A review run that reached no verdict: the run exited badly, ran out of patience, or answered in a shape that does not validate. Recorded as what it is, never as a clean verdict.
_Avoid_: error, crash

**Re-run rule**:
When a review run is repeated on a pull request that has already had one: only where files outside the repository's `docs_only` globs changed since that run. A force flag overrides it.
_Avoid_: cache, debounce

**Fix session**:
An interactive agent session mission control opens for me in a fresh worktree, carrying the findings I selected and my notes on them. The worktree stands on a branch of the tool's own that tracks the pull request's, and it outlives the session, because what I commit in it is mine. It is never the review run that produced the findings; the re-review of its result is a new review run.
_Avoid_: auto-fix, repair run

**Note**:
What I say about a finding when I pick it for a fix session. It is my word on the finding and outranks what the review run said about it.

### Screen

**Marker**:
The one character that says which bucket a row is in without being read: `●` needs me, `◐` needs a review run, `○` waiting on others, `◆` ready. It carries the bucket's colour, and it is what the row still says where there is no colour.
_Avoid_: icon, badge, glyph

**Block**:
How a command that reports rather than tabulates writes: a heading, an indented body, and a blank line before the next one. What each command says is its own; the shape is not.
_Avoid_: section, panel, group

**Heartbeat**:
The one line a command rewrites while it works: a spinner, how far it has got, how long it has taken. Gone the moment the work is, so what stays on the screen is the report. What it counts is the command's; the clock and the line are not.
_Avoid_: spinner, loader, progress bar

### Housekeeping

**Clone**:
The bare copy of a repository mission control keeps for itself, and cuts every worktree from. It is never my checkout, and nothing in it is mine: a run that needs it again makes it again.
_Avoid_: cache, mirror, checkout

**Cleanup**:
Taking back the disk mission control spends on itself: the clones, and the worktrees a review run left behind. It keeps what I decided and what it recorded, and it leaves a clone a session stands on where it is, because that session's history lives inside it.
_Avoid_: prune, gc, purge

**Uninstall**:
Removing everything mission control wrote on this machine, which no package manager does. The state goes in full and the configuration file only when I ask; the binary is the one step it cannot take and prints instead.
_Avoid_: remove, reset, wipe
