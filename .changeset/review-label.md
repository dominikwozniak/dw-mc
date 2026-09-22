---
"dw-mc": minor
---

`dw-mc` can label my own pull requests with what the review run at the current head found. Set `labels.enabled: true` for a repository and each PR gets `review: approved` or `review: changes`; the names are configurable under `labels.approved` and `labels.changes`. A sweep takes the label off when the head moves, and `dw-mc review` puts it on as soon as the run is recorded. A label the repository does not define is never created: the sweep prints the `gh label create` command instead.
