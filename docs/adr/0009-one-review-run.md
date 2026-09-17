# One review run per head, on Claude Code, configured rather than hard-coded

A head carries one review run. It runs on Claude Code, spawned through the launcher, and what it is asked lives in three keys: `review.command` is the slash command it opens on, `review.effort` is the word that follows the command, and `review.prompt` is my own review brief. Each of the three is overridable for one run by a flag on `dw-mc review`, because the run I want today is not always the run the repository is set up for.

The Codex CLI is gone, and with it the idea that a head can carry two opinions. One machine, one person and one review: a second opinion that never runs is an ordered `review.runners` array, a runner suffix in every storage key, a `runner` field on every stored record, a supporting-versus-deciding split with its own `stamp.supporting_blocks` switch, a `--runner` flag on two commands, and two questions in `dw-mc init`. Nothing here ran it, so all of that paid for nothing. What replaces it is that a run records the line it opened on and no more.

Four shapes fall out of two nullable keys, and each of them is a review: the slash command alone, the slash command with my instructions beside it, my instructions in front of the tool's own persona, and the persona alone. There is no configuration that reviews nothing, so there is no failure to write for one.

A slash command costs two turns, and that is Claude Code's doing rather than a choice. `--json-schema` beside `/code-review` breaks the run, so the review is asked for its findings on a second turn that resumes the same session — which also reads better than the prose, because the session still holds the diff the line numbers came from. An ordinary prompt takes the schema inline and answers in one turn. Which of the two a run is belongs to `src/adapters/claude.ts`, because the reason is a fact about the CLI ([ADR 0006](./0006-source-layout.md)); which turn to open belongs to `src/domain/persona.ts`, because that is a decision about text.

My own instructions ride on `--append-system-prompt` rather than on the slash command's own line. What a slash command does with its arguments is its business: `/code-review` takes an effort word there, and a paragraph appended after it would be this tool guessing at a grammar Anthropic owns and may change without saying so.

## Consequences

- The persona in `src/domain/persona.ts` belongs to the promptless shapes alone. A slash command is already a review, and putting a second set of review instructions behind it would be two reviewers arguing inside one turn.
- `review.effort` widens to Claude Code's own set — `low`, `medium`, `high`, `xhigh`, `max` — and may be null. A repository that spells its own arguments into `review.command` has no word left to append.
- A configuration file from an earlier version fails to read, and names the three keys to change. Why a file this version cannot read stops every command rather than being tolerated is [ADR 0010](./0010-configuration-that-cannot-be-read.md).
- Storage keys lose their runner suffix, which returns them to the shape they had before runners existed. A record an earlier version wrote carries no `command` field and therefore does not decode, and every reader already turns that into "no run" — so a stale record is forgotten rather than read as current. The cost is one re-review per pull request.
- `dw-mc init` asks nothing at all. The only choice it used to make was the runner; a slash command line and a review brief belong in the file, where I can edit them, and not in a terminal prompt.
- `dw-mc findings` loses `--runner`. There is one run at a head, so there is nothing to choose between.
