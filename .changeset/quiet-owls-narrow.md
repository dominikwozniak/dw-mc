---
"dw-mc": minor
---

`dw-mc status` and `dw-mc sweep` now cover only the repository you stand in, when that repository is
registered. Only its pull requests are shown, and the other registered repositories are not read from
GitHub at all. A line under the table names the repository shown and says that `--all` covers the rest.

`--repo owner/name` covers one registered repository from anywhere. `--all` covers every registered
repository, which is what both commands do outside a registered repository. The picker still lists
every registered repository.
