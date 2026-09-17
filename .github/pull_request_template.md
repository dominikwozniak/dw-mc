<!-- LEDE — one paragraph, at most four sentences. Why now: the problem this change answers.
     Present tense, as if the branch had always looked this way. No file list, no history, no
     "previously / now" — what changed since the last review goes in the conversation, not here.
     e.g. "`dw-mc merge` reads the stamp off the state directory and GitHub's verdict off the
     last sweep, so a merge can clear a bar that moved an hour ago. It reads both live instead." -->

## What changes

<!-- One to four bullets, one per unit of work, at most two lines each. Lead with the `path` or
     the command, then what it now does. Nothing the diff already says, nothing merely planned.
     e.g.
     - `src/cli/merge.ts` — reads GitHub's half from a fresh `pr view` rather than the sweep.
     - **CONTEXT.md** — "Ready" now says which of the two bars is live and which is on disk. -->

## How it flows

<!-- OPTIONAL — one small mermaid diagram, ten nodes at most, and only when the change moves a
     flow, a sequence or a state machine AND the picture beats the prose. Otherwise delete this
     section, heading included. No prose around it; the diagram stands alone.
     A fenced `mermaid` block holding something like:
        flowchart LR
          sweep[dw-mc sweep] --> place[place] --> bucket[bucket] --> pick[picker] -->

## Test plan

<!-- What was RUN and what it said — the command and its verdict, never an intention. A bug fix
     names its regression test. Whatever is left to do by hand goes last, marked "by hand".
     e.g.
     - `pnpm check` — pass
     - `src/domain/merge.test.ts` — 14/14, two new cases for a head that moved mid-run
     - by hand: `node dist/bin.js merge 62` against a stamped PR, refused on the stale stamp -->

## Risk

<!-- One line: what breaks if this is wrong, and the way back. Always filled — "None, docs only."
     is a real answer and the usual one. A write nothing brings back says so out loud. -->
