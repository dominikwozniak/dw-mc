# Source sits in three layers, and a directory arrives only when its code does

`src/` is laid out by what a module talks to, not by the feature it serves. Three layers, and imports cross them in one direction only: `cli` → `domain` → `adapters`.

**`adapters/`** is everything that touches the world outside the process: `gh` and the agent CLIs through the spawner, state through the key-value store, the keyboard and the screen through the terminal. Each adapter is a service with a real layer and a fake one, and it is the only place in the source where an external effect is allowed to live.

**`domain/`** is the deterministic core the design is built around: the buckets, the stamp, the flaky classifier, the re-run rule. It takes facts and returns decisions, so a test over it needs no layer at all.

**`cli/`** is the entry point and one file per subcommand. A command parses arguments, calls the domain, and prints; it holds no rule of its own, because a rule in a command cannot be tested without the command.

The direction is the whole point. An adapter that reaches back into a command couples the process boundary to the argument parser, and the deterministic core stops being testable on its own — which is what [ADR 0005](./0005-quality-toolchain.md)'s gate exists to protect.

A test lives beside the module it covers, and a module's fake ships inside that module rather than in a test-only file. The three seams are written that way already: the fake spawner, the in-memory store and the scripted terminal are exported by the modules they stand in for, so a caller's test reaches for one import and gets both the thing and its double.

The layout grows with the code and not ahead of it. A directory appears when a term from [`CONTEXT.md`](../../CONTEXT.md) has real code to put in it; `domain/` not existing while the tool can only parse `--help` is this rule working, not an exception to it. A fourth layer, or a folder inside one, is a change to this record — rewritten in place, no note of what it replaced — not a directory added quietly next to the others.

## Consequences

- A module's public surface carries its own fake, so `dist` ships the fakes too. That is the price of a caller importing the thing and its double from one path; a separate test-only entry point buys nothing back for a private CLI.
- The layers are enforced by the linter rather than by review, so the misplaced import fails in `pnpm lint` on the machine that wrote it.
- Splitting a layer into subdirectories needs a term in the glossary to name them. A folder the glossary has no word for is the signal to reach for `/domain-modeling` first.
