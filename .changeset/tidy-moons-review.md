---
"dw-mc": minor
---

A pull request now carries one review run, on Claude Code, and what that run opens on is yours to
configure. `review.command` is the slash command it runs — `/code-review` unless you say otherwise, or
`null` for none — `review.effort` is the word after it, now `low` through `max`, and `review.prompt` is
your own review brief: beside a slash command it steers the run through `--append-system-prompt`, and
without one it goes in front of the tool's own reviewer persona. Every one of the three is overridable
for a single run: `dw-mc review <pr> --command`, `--prompt`, `--effort`, `--model`, plus `--prompt-only`
and `--command-only` for the run that wants one of the two and not the other.

Codex support is gone, and so is the second opinion it existed for. `dw-mc init` no longer asks
anything, and `dw-mc findings` no longer takes `--runner`.

**This release changes the configuration file, and a file from an earlier version will not read.**
`dw-mc` names the keys and what replaced them: delete `review.runners` and `review.path_instructions`,
rename `review.skill` to `review.prompt`, and drop `stamp.supporting_blocks` and `launcher.codex` if you
set them. Review runs recorded by an earlier version are not read by this one, so the first review on
each pull request runs again.
