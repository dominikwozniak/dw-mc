# Vendored reference trees

Read-only. Nothing here is built, tested or imported. Application code imports from the installed
packages in `node_modules`, never from a path under `repos/`.

## `effect/`

The Effect monorepo, vendored with `git subtree` from `https://github.com/Effect-TS/effect.git`
on `main`. Update it with:

```sh
git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git main --squash
```

Reach for it only for what the published `effect` package does not carry. The package already ships
its own agent guide, its examples and its full TypeScript sources; those are the first stop, and
`AGENTS.md` at the repo root says so.

| question | file here |
| --- | --- |
| the shape of the whole library, module by module | `effect/LLMS.md` |
| v3 → v4 renames and removals | `effect/MIGRATION.md`, `effect/migration/` |
| `Schema` in depth, beyond the agent guide | `effect/packages/effect/SCHEMA.md` |
| `HttpApi`, `Config`, `Arbitrary`, `Optic`, MCP | the matching `*.md` in `effect/packages/effect/` |
| what changed in a release | `effect/packages/effect/CHANGELOG.md` |
| how the Effect team runs its own repo | `effect/.agents/skills/` |
| packages outside core: `platform`, `sql`, `ai`, `vitest`, `opentelemetry` | `effect/packages/` |
