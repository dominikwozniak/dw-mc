---
"dw-mc": patch
---

Every command that reports, rather than draws a table, lays its page out the same way: a heading, its lines indented under it, and a blank line before the next one. In a terminal, SHAs, paths, worktrees and titles print dim. A finding's severity takes its colour: error red, warning yellow, info dim. A command meant for you to retype, such as `dw-mc resolve 28` or `git push`, prints cyan. Headings and prose are never coloured, so `dw-mc comments` no longer prints its headings bold. What each command says is unchanged. Through a pipe or under `NO_COLOR` the text is the same as before, apart from a few blank lines.
