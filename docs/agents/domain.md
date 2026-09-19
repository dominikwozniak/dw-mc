# Domain docs

How the engineering skills consume this repo's domain documentation when exploring the codebase. This is a **single-context** repo: one `CONTEXT.md` and one `docs/adr/`, both at the root.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the glossary.
- **`docs/adr/`**: the decision records that touch the area you are about to work in.

If either is missing, **proceed silently**. Don't flag the absence; don't suggest creating them upfront. The `/domain-modeling` skill, reached on its own or via `/grill-with-docs`, creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-local-first.md
│   ├── 0002-github-write-boundary.md
│   └── …
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept, in an issue title, a spec, a hypothesis or a test name, use the term as `CONTEXT.md` defines it. Don't drift to synonyms the glossary avoids.

A concept missing from the glossary is a signal: either you are inventing language the project does not use, and should reconsider, or there is a real gap to note for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it rather than silently overriding:

> _Contradicts ADR 0002 (GitHub write boundary), but worth reopening because…_
