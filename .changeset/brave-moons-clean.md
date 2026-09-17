---
"dw-mc": minor
---

`dw-mc cleanup` takes back the disk the tool spends on itself — the bare clones and the worktrees a
review run left behind — and keeps your configuration, your records and the clone of any repository a
`fix` or `resolve` session still stands on. `dw-mc uninstall` removes everything the tool wrote on the
machine, takes the configuration file too with `--config`, and prints the one step it cannot take:
removing the package. Both print what they would take with its weight and ask first, and neither
touches a session worktree holding uncommitted changes or a commit the pull request's head does not
have until `--force` says so.
