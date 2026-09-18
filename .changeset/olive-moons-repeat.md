---
"dw-mc": patch
---

Nothing here changes what a command says or does. The state directory's layout is built and read back
in one place rather than spelled out at each end, the configuration writer is measured against its own
schema instead of against a fixture written by hand, the commands share the three lines they all open
with, and four sentences that were spelled twice are spelled once.

A state directory written by an earlier version reads the same under this one: no path, no branch name
and no key on disk has moved.
