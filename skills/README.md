# The skills dw-mc ships

`dw-mc/` is the `/dw-mc` skill: a thin way into mission control's state from an agent session I started myself. It calls the CLI and nothing else.

Install it from this repository:

```sh
pnpm dlx skills@latest add dominikwozniak/dw-mc
```

Or point the agent's skills directory at this one, so the skill follows the clone rather than a copy of it:

```sh
ln -s "$PWD/skills/dw-mc" ~/.claude/skills/dw-mc
```

Nothing here is loaded by the binary, and none of it is in the published package: these are files an agent reads, and they come from the repository rather than from npm. The skill names the CLI's terms by link, so a copy installed anywhere still reaches the glossary.
