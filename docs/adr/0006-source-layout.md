# Source sits in three layers, and a directory arrives only when its code does

A module in `src/` belongs to a layer chosen by what it talks to, not by the feature it serves. There are three, and imports cross them in one direction only: `cli` → `domain` → `adapters`.

**`adapters/`** is where the outside world is reached: GitHub and the runners through the spawner, state through the key-value store, the keyboard and the screen through the terminal. An adapter owns that boundary, and it exports the double its callers' tests need alongside the thing itself.

**`domain/`** is the deterministic core: the buckets, the stamp, the flaky classifier, the re-run rule, the decision to rebase. It takes facts and returns decisions, so a test over it needs no layer at all.

**`cli/`** is the entry point and one file per subcommand. A command parses arguments, calls the domain and prints; it holds no rule of its own, because a rule in a command cannot be tested without the command. The entry point is the one file that assembles the real layers, which is why it is also the one place the platform services are provided.

The direction is the whole point. An adapter that reaches back into a command couples the process boundary to the argument parser, and the deterministic core stops being testable without spawning something.

A module is named, never counted: `#adapters/config.ts`, whether the importer sits in another layer or next door. The name is a node subpath import declared in `package.json`, so it survives the build and reads the same from everywhere, and the layer a module belongs to is stated at each call site rather than inferred from how many `../` precede it. There is no relative import in `src/`, which also means moving a file between layers changes that file and not its importers.

A test lives beside the module it covers, and a module ships the fake its callers need rather than a test-only file next door. The three seams are written that way already: `src/adapters/spawner.ts` exports the fake spawner, `src/adapters/store.ts` the in-memory store, `src/adapters/picker.ts` the scripted terminal, so a caller's test reaches for one import and gets both the thing and its double.

The layout grows with the code and not ahead of it. A directory appears when there is code to put in it; `domain/` not existing while nothing yet takes facts and returns a decision is this rule working, not an exception to it. A fourth layer is a change to this record — rewritten in place, no note of what it replaced — not a directory added quietly next to the others.

## Consequences

- A module's public surface carries its own fake. The price is paid in the source and not in the package: the bundler starts at the entry point, so a fake no command reaches is shaken out and never lands in `dist`. A separate test-only entry point would buy nothing back.
- Three of the rules above are invisible in a diff that only adds an import, so `no-restricted-imports` in [`.oxlintrc.json`](../../.oxlintrc.json) holds all three: an import reaching up a layer, a relative specifier anywhere in `src/`, and `@effect/platform-node` outside the entry point and the tests that assemble their own layers each fail `pnpm lint`. The direction's patterns have to match both spellings a module has, the subpath name and the relative path, or half the ways in go unguarded. An override replaces the rule's configuration in full rather than merging into it, which is where this is easiest to get wrong; [ADR 0005](./0005-quality-toolchain.md) carries that trap.
- The layer names are structural and stay out of [`CONTEXT.md`](../../CONTEXT.md). A directory _inside_ a layer is a domain concept and needs the glossary's word for it; a folder the glossary cannot name is the signal to reach for `/domain-modeling` first.
