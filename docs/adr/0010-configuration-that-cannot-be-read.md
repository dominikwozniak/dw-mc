# A configuration file this version cannot read stops every command that reads it, and names what to change

`read` decodes `config.yaml` with `onExcessProperty: "error"`, so a key this version does not have is a
failure and never a default that quietly means something else. A release that removes or renames a key
therefore breaks every command that reads the file on a machine whose file still spells it, `dw-mc init`
included, because it reads before it writes. That is the intended outcome: the alternative to stopping is
running, and a review that runs under settings I no longer have is worse than a command that will not
start.

Two commands stand outside that, because neither has anything to read the file for. `dw-mc cleanup` takes
back the disk the tool spent on itself and never opens the file. `dw-mc uninstall` wants the file's path
and not what is in it — a file too broken to decode is exactly when taking the tool off this machine has
to work. `src/cli/cli.test.ts` runs every command that reads the file against one it cannot read, and
carries a reason for each command it leaves out, so one added to the CLI fails until it lands in a list.

What the failure owes me is the way out. The generic excess-property error names each key it did not
expect, which is enough for a key that is simply gone and not enough for one that moved: a file quietly
stripped of `review.skill` is a review brief lost. So `legacyIn` runs before the decode and says, per
key, what replaced it. It is a list of one release's removals, it is meant to be deleted once no file
carries those keys, and it is the only place this tool knows anything about its own past.

Two alternatives were rejected. **Tolerating the dead keys** — accepting them as unknown and ignoring
them — puts a permanent hole in the invariant the strict decode exists for, and `review.skill` being
ignored in silence is exactly the failure that invariant prevents. **Migrating the file automatically**
would rewrite a file I keep in my dotfiles, without asking, to save me one edit.

## Consequences

- A removal or rename in `config.yaml` is a breaking change and carries a changeset that leads with the
  edit to make. Under `0.x` that is a minor, because `major` would publish `1.0.0`.
- `legacyIn` has to be kept honest by hand: a key removed later and not added to it fails with the
  generic error, which is correct but says less.
- `dw-mc --help` keeps going on such a file. It runs nothing under the settings, so it says only that the
  file cannot be read and names its path; a command that reads it prints why.
- The same rule does not hold for the state directory. State is a cache of work that can be done again,
  so a record this version cannot read is forgotten rather than fatal, and the cost is one re-review.
