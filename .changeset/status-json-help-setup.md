---
"dw-mc": minor
---

`dw-mc status --json` prints the same pass as one JSON document, for `jq` or an agent session: every tracked PR with its bucket, reason, stamp, what moved and every fact, then the repositories the pass covered, how many it left out and what it could not read. It honours `--repo` and `--all`, and it leaves the mark of what you last looked at where it was. `dw-mc --help` names your configuration file, how many repositories it registers and the state directory under the logo.
