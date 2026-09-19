# dw-mc

## 0.8.0

### Minor Changes

- 568c164: `dw-mc status --json` prints the same pass as one JSON document, for `jq` or an agent session: every tracked PR with its bucket, reason, stamp, what moved and every fact, then the repositories the pass covered, how many it left out and what it could not read. It honours `--repo` and `--all`, and it leaves the mark of what you last looked at where it was. `dw-mc --help` names your configuration file, how many repositories it registers and the state directory under the logo.

### Patch Changes

- 454b8b0: Every command that reports, rather than draws a table, lays its page out the same way: a heading, its lines indented under it, and a blank line before the next one. In a terminal, SHAs, paths, worktrees and titles print dim. A finding's severity takes its colour: error red, warning yellow, info dim. A command meant for you to retype, such as `dw-mc resolve 28` or `git push`, prints cyan. Headings and prose are never coloured, so `dw-mc comments` no longer prints its headings bold. What each command says is unchanged. Through a pipe or under `NO_COLOR` the text is the same as before, apart from a few blank lines.

## 0.7.0

### Minor Changes

- 5fd4f25: `dw-mc merge` forgets the pull request it merged: every record, review run and report the state directory kept about it. `dw-mc forget <pr>` does the same by hand for a pull request that closed another way. A sweep still removes nothing, and a `fix` or `resolve` session's worktree survives both and is named.
- 26048d0: `dw-mc status` and the picker mark what moved since you last looked. A row whose bucket or whose facts changed carries `*`, a pull request never shown carries `+`, and a line above the group says where the row came from and what moved. `dw-mc sweep` shows nothing, so it leaves the mark where it was. The first `dw-mc status` after upgrading has shown you nothing yet, so it marks every row `+`.
- b3771a2: `dw-mc comments <pr> --ack` records that you have read a pull request's conversation and nothing in it is yours to answer. The acknowledgement counts beside your last comment and your last commit, so the pull request leaves Needs me until somebody says something newer. It survives a push, and it never lifts changes requested.

## 0.6.0

### Minor Changes

- 1a608ad: `dw-mc status` and `dw-mc sweep` now cover only the repository you stand in, when that repository is
  registered. Only its pull requests are shown, and the other registered repositories are not read from
  GitHub at all. A line under the table names the repository shown and says that `--all` covers the rest.

  `--repo owner/name` covers one registered repository from anywhere. `--all` covers every registered
  repository, which is what both commands do outside a registered repository. The picker still lists
  every registered repository.

## 0.5.1

### Patch Changes

- 93d449e: Nothing here changes what a command says or does. The state directory's layout is built and read back
  in one place rather than spelled out at each end, the configuration writer is measured against its own
  schema instead of against a fixture written by hand, the commands share the three lines they all open
  with, and four sentences that were spelled twice are spelled once.

  A state directory written by an earlier version reads the same under this one: no path, no branch name
  and no key on disk has moved.

## 0.5.0

### Minor Changes

- ebba848: Every command that works before it can print now says so, on one line it rewrites and wipes when the
  work is done. `dw-mc status`, `dw-mc` and `dw-mc sweep` count the repositories they search and then the
  pull requests they read; a command that reads a pull request's guards live says which one it is reading;
  a clone says whether it is arriving for the first time or being fetched, and a worktree says it is being
  cut; `dw-mc cleanup` says it is measuring the disk before it says what that weighs.

  Piped or redirected, every command prints exactly what it printed before. The line is drawn only where
  there is a terminal with a width to draw in.

## 0.4.0

### Minor Changes

- 37875ea: A pull request now carries one review run, on Claude Code, and what that run opens on is yours to
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

## 0.3.0

### Minor Changes

- c647a6a: `dw-mc status` gives every row's pull request reference the URL it opens at, so a terminal that follows
  OSC 8 links opens the pull request from the table. The text on the row is the reference it always was,
  and a pipe, a paste and a terminal that ignores the sequence read exactly what they read before.

### Patch Changes

- d7b37fe: `dw-mc cleanup` takes back the disk the tool spends on itself — the bare clones and the worktrees a
  review run left behind — and keeps your configuration, your records and the clone of any repository a
  `fix` or `resolve` session still stands on. `dw-mc uninstall` removes everything the tool wrote on the
  machine, takes the configuration file too with `--config`, and prints the one step it cannot take:
  removing the package. Both print what they would take with its weight and ask first, and neither
  touches a session worktree holding uncommitted changes or a commit the pull request's head does not
  have until `--force` says so.

## 0.2.0

### Minor Changes

- 8e0da73: `dw-mc comments <pr>` prints the conversation on a tracked pull request: by default what is newer than
  your last comment or commit, which is what puts the pull request in Needs me, and the whole of it under
  `--all`. Threads come from GraphQL, so a resolved or outdated one is left out rather than answered again.

### Patch Changes

- 6bb9b16: Releases are published from CI with a provenance attestation, so every version on the registry names the commit and the workflow that built it.
