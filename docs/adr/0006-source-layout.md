# Source sits in four layers, and a directory arrives only when its code does

A module in `src/` belongs to a layer chosen by what it talks to, not by the feature it serves. There are four, and imports cross them in one direction only: `cli` → `domain` → `adapters` → `terms`.

**`terms/`** is the words. A literal union, a schema, the shape a value has — and no rule, no branch, no reach outside the process. It is at the bottom because a word is the one thing every layer has to agree on: `gh` answers in `Mergeability` and the bucket rules decide on it, the domain writes a `ReviewTurn` and Claude Code spawns it. A word declared in the layer that happens to be lowest is a word the layer above has to reach down for, and a word declared on both sides of a seam is two words that drift.

**`adapters/`** is where the outside world is reached: GitHub and the agent CLI through the spawner, state through the key-value store, the keyboard and the screen through the terminal. An adapter owns that boundary, and it exports the double its callers' tests need alongside the thing itself.

**`domain/`** is the rules: the buckets, the stamp, the flaky classifier, the re-run rule, the decision to rebase. Every one of them is a function from facts to a decision, and a test over that function needs no layer at all. Where the facts a rule reads are the tool's own — a withdrawal, a conflict record, the last review run — the read sits beside the rule rather than in the command, because two commands asking the same question have to get the same answer. Those reads take the key-value store and nothing else, so a test over them needs the in-memory store and still nothing else.

**`cli/`** is the entry point and one file per subcommand. A command parses arguments, calls the domain and prints; it holds no rule of its own, because a rule in a command cannot be tested without the command. The entry point is the one file that assembles the real layers, which is why it is also the one place the platform services are provided.

The direction is the whole point. An adapter that reaches back into a command couples the process boundary to the argument parser, and the rules stop being testable without spawning something.

What is a term and what is a rule's input is decided by who has to agree on it. `Facts` is not a term: it is "everything the bucket rules are allowed to know", and it lives in `domain/bucket.ts` so that an adapter cannot build one. A command assembles a `Facts` out of what several adapters answered, which is the layer direction doing its job. A union that both `gh` and a bucket rule must read is a term, and the moment it is declared twice it has stopped being one.

A module is named, never counted: `#adapters/config.ts`, whether the importer sits in another layer or next door. The name is a node subpath import declared in `package.json`, so it survives the build and reads the same from everywhere, and the layer a module belongs to is stated at each call site rather than inferred from how many `../` precede it. There is no relative import in `src/`, which also means moving a file between layers changes that file and not its importers.

A test lives beside the module it covers, and a module ships the fake its callers need rather than a test-only file next door. The seams are written that way: `src/adapters/spawner.ts` exports the fake spawner, `src/adapters/store.ts` the in-memory store, `src/adapters/picker.ts` the scripted terminal, `src/adapters/config.ts` the in-memory configuration, so a caller's test reaches for one import and gets both the thing and its double.

The layout grows with the code and not ahead of it. A directory appears when there is code to put in it. A fifth layer is a change to this record — rewritten in place, no note of what it replaced — not a directory added quietly next to the others.

## Consequences

- A module's public surface carries its own fake. The price is paid in the source and not in the package: the bundler starts at the entry point, so a fake no command reaches is shaken out and never lands in `dist`. A separate test-only entry point would buy nothing back.
- Three of the rules above are invisible in a diff that only adds an import, so `no-restricted-imports` in [`.oxlintrc.json`](../../.oxlintrc.json) holds all three: an import reaching up a layer, a relative specifier anywhere in `src/`, and `@effect/platform-node` outside the entry point and the tests that assemble their own layers each fail `pnpm lint`. The direction's patterns have to match both spellings a module has, the subpath name and the relative path, or half the ways in go unguarded. An override replaces the rule's configuration in full rather than merging into it, which is where this is easiest to get wrong; [ADR 0005](./0005-quality-toolchain.md) carries that trap, and a layer with no block of its own silently inherits a root that names none of the others.
- `tsconfig.json` excludes `src/**/*.test.ts`, so a test that imports a type from the wrong module is caught by the linter and never by `pnpm typecheck`. The import guards are the whole check there.
- The layer names are structural and stay out of [`CONTEXT.md`](../../CONTEXT.md). `terms/` is the one place the two meet: what goes in it is what the glossary names, and a file there the glossary cannot name is the signal to reach for `/domain-modeling` first. A directory _inside_ a layer is a domain concept and needs the glossary's word for it too.
