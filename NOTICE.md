# Notices

`dw-mc` is MIT licensed, and so is everything it carries. What it carries from
someone else is listed here.

## The reviewer persona

`src/domain/persona.ts` holds the review prompt a run with no slash command opens on. Its
body is derived from the `code-reviewer` agent of
[`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills)
(`agents/code-reviewer.md`, commit `be4e44a`), by Addy Osmani, MIT licensed.

Taken: the five review dimensions with their questions, the four severity words
— Critical, Required, Optional, Nit — and the working rules.

Changed: the answer is structured output against this tool's finding schema, so
the Markdown report template is gone and each severity word says which of
`error`, `warning` and `info` it is reported as. The prose is rewritten in this
repository's register.

```
MIT License

Copyright (c) 2025 Addy Osmani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
