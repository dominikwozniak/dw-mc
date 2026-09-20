---
"dw-mc": patch
---

An action picked in `dw-mc` says once what went wrong with it. A failure used to be printed twice, because the picker runs the command it dispatches and the run standing outside it both rendered the same sentence.
