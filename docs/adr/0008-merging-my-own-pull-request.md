# Merging my own pull request is its own write, with its own threshold

[ADR 0002](./0002-github-write-boundary.md) admits three writes and says so in its title. Each acts on my own work and leaves no mark anybody else has to read. A merge fails the second half: it moves a shared branch, and no reflog of mine brings it back. It is not a fourth item there, because adding it would break the sentence that makes 0002 legible.

So it is this record instead, written narrowly: about merging a pull request I author, and about nothing else the tool might do to a shared branch. Tags and releases are a different question and this does not answer it.

## The threshold

Ready **and** my stamp, both at the head the command reads.

Ready is GitHub's opinion: approved, green, mergeable. The stamp is mine: a review run on this head with nothing blocking. The one write no reflog undoes clears both bars, because each of them is blind to what the other sees. GitHub does not know whether anything read the diff; the stamp does not know whether a reviewer asked for changes.

The stamp already insists on green CI where the flaky classifier excused a red check ([`src/domain/stamp.ts`](../../src/domain/stamp.ts)). That holds here and is the point of holding it: an excuse is a reason not to fix a check, not a reason to land code behind it.

A pull request that is Ready without a stamp is refused with the command that earns one, the way a rebase refuses a stack.

## The mechanics

`gh pr merge --squash --delete-branch`. Squash is how this repo lands pull requests, and the squash subject is the pull request title. The branch is mine and squashing kills it anyway.

No `--auto`. That hands GitHub a deferred write: a merge that happens when I am not looking, at a head I have not read. Every verdict in this tool is about one head, which is why the CI re-run is capped per head and asked for by hand.

Every guard is read live from a fresh `pr view`, the way the rebase and re-run guards are. The withdrawal and the review runs come from the state directory, being local and head-scoped. A ten-minute-old verdict costs a re-run some CI minutes; here it costs merging code nobody read.

The picker offers it on a Ready, stamped pull request behind a confirmation of its own. Every other action there is cheap or reversible, and one keystroke too many must not merge a pull request and delete its branch. A typed `dw-mc merge` is its own confirmation and takes no flag.

## Consequences

- The boundary sentence changes shape: the tool does not merge _other people's_ pull requests, rather than not merging at all. Everything else 0002 bars - comment, reply, thread resolve, review, approval, status - still holds everywhere. The review label is ADR 0012's.
- A pull request in a stack is not refused here. Its base is another branch, so a squash merge lands it there and `--delete-branch` takes a branch the stack is built on. Driving stacks is out of scope for v1 and this is one of the edges of that.
- A merge nothing stamped is unreachable through this tool. Where I want one anyway, the merge button is still on the pull request.
