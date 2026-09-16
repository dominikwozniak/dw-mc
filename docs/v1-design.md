# dw-mc v1: the decided design

`dw-mc` is a local CLI in TypeScript + Effect v4 that keeps the state of my open pull requests on disk, reads GitHub through `gh`, runs review runs through local agent CLIs, and shows me what every PR waits on. Nothing leaves the machine but those calls. It is built for me and installable by anyone.

Vocabulary is in [`CONTEXT.md`](../CONTEXT.md). Boundaries are in [`docs/adr/`](./adr/). This file is the rest: every decision the design interview settled, the mechanics that were verified by running them, and the order to build in. It is a snapshot; when a decision changes, this file changes.

## Decisions

| area | decision |
| --- | --- |
| who orchestrates | The tool. Facts, buckets, stamp and rebase are deterministic code. A model runs only inside a review run. A thin `/dw-mc` skill calls the CLI. |
| state | JSON files validated with `Schema` on read, one directory of state outside any repo (`$XDG_STATE_HOME/dw-mc`, or `~/.local/state/dw-mc` when XDG says nothing). Review-run reports are Markdown next to them. SQLite only when a query the files cannot answer appears. |
| git | Every run works in a throwaway worktree cut from the tool's own bare clone of the repo, kept in the state directory. My checkout is never touched. |
| GitHub, reads | `gh` as me: `gh search prs --author=@me --repo <tracked>` for the sweep, `gh pr view --json` per PR, `gh api` for reviews, comments and check runs. |
| GitHub, writes | Only pushes to branches I author and edits to my PR bodies (unused in v1). Never a comment, reply, thread resolve, label, review, approval, status or merge. Comment-triggered reviewers a repo already has (CodeRabbit, a `@claude-review` workflow) are observed by author login and head SHA, never triggered. |
| buckets | Needs me › Needs review run › Waiting on others › Ready. A draft is a flag on a tracked PR, never acted on unless I ask. |
| Needs me | Merge conflict, red CI that the flaky classifier calls legit, changes requested, a human comment newer than my last commit or comment, or a blocking finding on the current head. |
| Needs review run | No review run recorded for the current head. |
| Waiting on others | Nothing left for me and a human review is pending. |
| Ready | Approved, green, mergeable. Merging is my click, outside the tool. |
| review run | Started by hand: `dw-mc review <pr> [--effort low\|medium\|high]`. Runs in the foreground with progress; ends with a terminal bell and a macOS notification through `osascript`. |
| runners | `builtin`: Claude Code's built-in `/code-review <effort>` headless, then a second turn in the same session that applies the repo's path instructions and returns the findings as schema-validated JSON. `prompt`: the tool's own prompt with the same JSON schema, run on Claude Code or Codex; its default body is Addy Osmani's `code-reviewer` persona (MIT). Codex is chosen at setup and its findings never block the stamp unless the config says so. |
| finding schema | `{ verdict: clean \| findings, findings: [{ file, line, severity: error \| warning \| info, summary }] }`. Persona severities map Critical and Required to `error`, Optional to `warning`, Nit and FYI to `info`. |
| re-run rule | A review run is repeated only when files outside the repo's `docs_only` globs changed since the last run on that PR. |
| stamp | Computed: a review run on the current head with no `error` finding, CI green, mergeable. `dw-mc stamp --withdraw <pr>` removes it by hand until the head changes. The stamp is my bar, independent of the repo's own policy. |
| fixes | Report only. `dw-mc fix <pr>` opens a MultiSelect of findings, takes an optional note per finding, then launches an interactive `claude` in a fresh worktree with the selected findings as JSON in the prompt. I steer, commit and push. The re-review is a new review run. Inside an open session, `/dw-mc findings <pr>` prints the same JSON. |
| rebase | Single branch only: when behind its base and CI is green or absent, rebase onto the base and `push --force-with-lease`. A conflict aborts the rebase and puts the PR in Needs me. Never while CI is running. A stacked PR is reported with its position; the stack is never driven. |
| CI | Flaky versus legit by three deterministic signals: the default branch is red for the same workflow, the failing log names changed files, the log matches known flaky patterns. A flaky failure is re-run once per head SHA. A legit failure is reported, never fixed. |
| sweep | On demand: `dw-mc sweep`, and implicitly when `dw-mc status` or the picker opens. No watch mode, no daemon, no discovery of new PRs in the background. |
| interface | Subcommands print tables. `dw-mc` with no arguments opens a picker built on Effect `Prompt`: pick a PR, pick an action, read the report. No full-screen TUI and no web UI in v1. |
| tracking | `dw-mc init` run inside a repo registers `owner/repo` (from `gh repo view`) and its per-repo settings. The first `init` on a machine also runs the machine setup: `gh auth status`, runner choice, state directory. There is no separate `setup` command. |
| config | `~/.config/dw-mc/config.yaml` with `defaults` and `repos["owner/name"]`. A future in-repo `.dw-mission-control.yaml` uses the same schema and is read from the default branch, never from the PR branch. Precedence: global defaults, then the in-repo file, then the global per-repo section. v1 ships the global file only. |
| review instructions | Stay in the repo's `AGENTS.md` / `CLAUDE.md`, which the built-in review reads. Optional `path_instructions` in config carry the rest. |
| naming | Repository `dominikwozniak/dw-mc`, binary and package `dw-mc`, skill `/dw-mc`. |

### Config schema

```yaml
defaults:
  base: null                   # default branch from gh when null
  review:
    runners: [builtin]         # builtin | prompt
    effort: low                # builtin only
    model: null                # prompt only
    skill: null                # passthrough, e.g. a repo's own review skill
    docs_only: ["**/*.md", "docs/**"]
    path_instructions: []      # [{ path: glob, instructions: text }]
  ci:
    ignore: []                 # check names that do not count towards green
    flaky_patterns: []
  rebase:
    enabled: false
  stamp:
    blocks_on: error
repos:
  owner/name:
    # same keys, overriding defaults
```

## Verified mechanics

Each line says whether it was run or read.

- Run: `claude -p "/code-review low" --output-format stream-json` works headless. The findings come back as text in `result`, one `file:line — description` per line. No `ReportFindings` tool call appears in the stream and `structured_output` is empty.
- Run: passing `--json-schema` on that same call breaks it: `result` becomes `Command completed`.
- Run: `claude -p --resume <session_id> "Report the findings as structured output…" --output-format json --json-schema <schema>` returns the findings as validated JSON under `structured_output`, with line numbers more accurate than the text. The `session_id` comes from the first call's JSON result.
- Run: `claude -p "/security-review"` headless returns nothing: zero turns, empty result. Not a runner.
- Run: `codex exec --help` in Codex CLI 0.153 lists `--json` and `--output-schema <FILE>`.
- Read, in the Claude Code docs: `claude --resume <id>` resolves a session across directories from 2.1.223, so a fix session can open in a worktree the review did not run in. Confirm by running it before relying on it.
- Read, in the plugin's command file: the `code-review` marketplace plugin posts a comment with `gh pr comment`. Read, in the Claude Code docs: the built-in `/code-review` comments only with `--comment`, which the tool never passes.

## Effect v4 modules to use

Read `node_modules/effect/AGENTS.md` first, then `repos/effect/LLMS.md` for the module map ([ADR 0004](./adr/0004-effect-reference-material.md)). Everything below is under `node_modules/effect/src` unless noted.

| need | module |
| --- | --- |
| CLI commands, flags, subcommands | `unstable/cli` `Command`, example `ai-docs/src/70_cli/10_basics.ts` |
| interactive picker | `unstable/cli` `Prompt`: `Select`, `MultiSelect`, `Confirm`, `AutoComplete`; needs `Terminal` from `@effect/platform-node` `NodeTerminal` |
| spawning `gh`, `claude`, `codex` | `unstable/process` `ChildProcess.make` + `ChildProcessSpawner` (`string`, `lines`, `spawn`, `exitCode`), example `ai-docs/src/60_child-process/` |
| typed JSON state files | `unstable/persistence` `KeyValueStore.layerFileSystem(dir)` + `toSchemaStore(store, schema)` |
| filesystem, paths, services | core `FileSystem`, `Path`; `NodeServices.layer` from the `@effect/platform-node` package |
| retries and polling | `Schedule` |
| tables | none in Effect; a small formatter of our own on `Terminal` |

## Patterns lifted from the references

The reference trees are vendored in the private workshop, the sibling directory `dw-mission-control`, under `repos/` with a router in `repos/AGENTS.md`.

- Quiet PR rule (skip a PR whose head SHA, CI conclusion and newest comment are unchanged): `haacked-dotfiles/ai/skills/babysit-prs/SKILL.md`.
- Flaky classifier signals and scoring: `haacked-dotfiles/ai/skills/ci-monitor/scripts/ci-classify-failure.sh`.
- Finding schema, fix prompt that carries the findings JSON verbatim, and separate reviewer and fixer sessions: `no-mistakes/internal/pipeline/steps/{common,review}.go`, `internal/types/findings.go`.
- Per-repo `path_instructions` read only from the default branch: `no-mistakes/internal/config/config.go`.
- Blocking reason as one function over mergeable state, review decision and check results: `talyn/packages/backend/src/services/githubGraphql.ts` `computeBlockingReason`.
- Re-run reviews only when non-doc files changed: `pauldambra-dotfiles/ai/skills/pr-shepherd/SKILL.md`.
- Reviewer persona for the `prompt` runner: `addyosmani-agent-skills/agents/code-reviewer.md`.

## Build order

Each item is one tracer bullet: end to end, thin, observable.

1. `dw-mc init`: machine setup on first run, then repo registration from the current directory.
2. `dw-mc sweep` and `dw-mc status`: the read-only table with the four buckets.
3. `dw-mc review <pr> [--effort]` with the `builtin` runner; findings JSON and Markdown report on disk; `dw-mc findings <pr> --json`.
4. Computed stamp and `dw-mc stamp --withdraw <pr>`.
5. `dw-mc fix <pr>`: picker, notes, fix session in a worktree.
6. `dw-mc rebase <pr>` for a single branch, and the flaky re-run.
7. The `prompt` runner with the persona body, on Claude Code and Codex.
8. The `/dw-mc` skill and the no-argument picker.

## Out of scope for v1

Summaries and repository graphs, PR body edits, driving stacks, automatic fixes of findings or CI, a watch mode or background discovery, a web UI, a full-screen TUI, a headless security review, and posting anything to GitHub beyond ADR 0002.
