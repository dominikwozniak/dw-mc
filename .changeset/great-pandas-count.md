---
"dw-mc": minor
---

Every command that works before it can print now says so, on one line it rewrites and wipes when the
work is done. `dw-mc status`, `dw-mc` and `dw-mc sweep` count the repositories they search and then the
pull requests they read; a command that reads a pull request's guards live says which one it is reading;
a clone says whether it is arriving for the first time or being fetched, and a worktree says it is being
cut; `dw-mc cleanup` says it is measuring the disk before it says what that weighs.

Piped or redirected, every command prints exactly what it printed before. The line is drawn only where
there is a terminal with a width to draw in.
