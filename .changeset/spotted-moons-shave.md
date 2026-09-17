---
"dw-mc": minor
---

`dw-mc comments <pr>` prints the conversation on a tracked pull request: by default what is newer than
your last comment or commit, which is what puts the pull request in Needs me, and the whole of it under
`--all`. Threads come from GraphQL, so a resolved or outdated one is left out rather than answered again.
