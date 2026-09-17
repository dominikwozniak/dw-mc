# Security policy

## Supported versions

| Version | Supported                    |
| ------- | ---------------------------- |
| 0.x     | ✅ — the latest release only |

`dw-mc` stays on `0.x` while Effect is a release candidate. Fixes land on the latest version; there are no backports.

## Reporting a vulnerability

**Do not open a public issue for a security report.**

Use GitHub's private reporting instead: [**Report a vulnerability**](https://github.com/dominikwozniak/dw-mc/security/advisories/new). It opens a draft advisory only you and the maintainer can read.

Include what you can:

- what the issue is, and what an attacker gets out of it
- the version, from `dw-mc --version`
- steps to reproduce, or a proof of concept
- the operating system, and which agent CLIs are configured

## What to expect

| Step                                    | When                            |
| --------------------------------------- | ------------------------------- |
| Acknowledgement                         | within 72 hours                 |
| Assessment, and whether it is confirmed | within 7 days                   |
| A fix or a mitigation plan              | within 30 days of confirming it |

This is one person's project, not a staffed security team — the timings are what is realistic, and you will hear if something slips.

## Scope

`dw-mc` runs on your machine, under your account, with your `gh` token and your agent CLIs. In scope:

- anything that makes the tool write to GitHub outside the boundary [ADR 0002](./docs/adr/0002-github-write-boundary.md) and [ADR 0008](./docs/adr/0008-merging-my-own-pull-request.md) draw
- a pull request's own content — a title, a branch name, a comment, a finding — reaching a shell, a spawned process's arguments, or the prompt of an agent session in a way that was not intended
- credentials, tokens or state written where they should not be, or with permissions they should not have
- a merge, a force push or a branch deletion the tool makes without clearing both bars it is meant to clear

Out of scope: vulnerabilities in `gh`, `git`, Claude Code or Node itself — report those to their own projects; anything that needs an attacker to already have your shell.

## Disclosure

Coordinated. Give the fix reasonable time before you go public, and you will be credited in the release notes unless you would rather not be.
