# The skills dw-mc ships

`dw-mc/` is the `/dw-mc` skill: a thin way into mission control's state from an agent session I started myself. It calls the CLI and nothing else.

Install it by pointing the agent's skills directory at this one, so the skill follows the clone rather than a copy of it:

```sh
ln -s "$PWD/skills/dw-mc" ~/.claude/skills/dw-mc
```

Nothing here is loaded by the binary. These are files an agent reads, and they are shipped with the package so the skill and the CLI it calls are the same version.
