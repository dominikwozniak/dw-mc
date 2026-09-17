import { RuleTester } from "oxlint/plugins-dev"

import { noGhWritesRule } from "./no-gh-writes.ts"

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })
const notARead = { messageId: "notARead" }
const apiWrite = { messageId: "apiWrite" }
const writeNeedsFlag = { messageId: "writeNeedsFlag" }

tester.run("dw-mc/no-gh-writes", noGhWritesRule, {
  valid: [
    `capture("gh", ["--version"])`,
    `capture("gh", ["auth", "status"])`,
    `capture("gh", ["repo", "view", "--json", "nameWithOwner"])`,
    `readJson("pr view", "gh", ["pr", "view", String(number), "--repo", repo, "--json", fields], PrView)`,
    `readJson("run list", "gh", ["run", "list", "--repo", repo, "--limit", "5", "--json", "conclusion"], Runs)`,
    `readJson("search prs", "gh", ["search", "prs", "--author=@me", "--state=open"], SearchResults)`,
    `readJson("api user", "gh", ["api", "user"], User)`,
    'capture("gh", ["api", `repos/${repo}/actions/jobs/${jobId}/logs`, "--allow-escape-sequences"])',
    {
      name: "the one write ADR 0002 admits",
      code: `capture("gh", ["run", "rerun", runId, "--repo", repo, "--failed"])`
    },
    {
      name: "another program's vector is not this rule's business",
      code: `capture("git", ["push", "--force-with-lease"])`
    }
  ],
  invalid: [
    { name: "a write verb", code: `capture("gh", ["pr", "merge", "27"])`, errors: [notARead] },
    {
      name: "a re-run of the whole workflow run, which is not the failed jobs",
      code: `capture("gh", ["run", "rerun", runId, "--repo", repo])`,
      errors: [writeNeedsFlag]
    },
    { name: "a read nobody has admitted", code: `capture("gh", ["label", "list"])`, errors: [notARead] },
    { name: "a verb built at runtime", code: `capture("gh", [verb, "view"])`, errors: [notARead] },
    { name: "a vector assembled elsewhere", code: `capture("gh", args)`, errors: [notARead] },
    { name: "no vector at all", code: `capture("gh")`, errors: [notARead] },
    { name: "an empty vector", code: `capture("gh", [])`, errors: [notARead] },
    { name: "-X", code: `capture("gh", ["api", "repos/o/r/issues/1/comments", "-X", "POST"])`, errors: [apiWrite] },
    { name: "-X with its value attached", code: `capture("gh", ["api", "repos/o/r", "-XPATCH"])`, errors: [apiWrite] },
    {
      name: "--method",
      code: `capture("gh", ["api", "repos/o/r/issues/1/comments", "--method", "POST"])`,
      errors: [apiWrite]
    },
    { name: "--method=", code: `capture("gh", ["api", "repos/o/r", "--method=PUT"])`, errors: [apiWrite] },
    { name: "-f", code: `capture("gh", ["api", "repos/o/r/issues/1/comments", "-f", "body=no"])`, errors: [apiWrite] },
    { name: "-F", code: `capture("gh", ["api", "repos/o/r/issues/1/comments", "-F", "body=@x"])`, errors: [apiWrite] },
    {
      name: "--field",
      code: `capture("gh", ["api", "repos/o/r/issues/1/comments", "--field", "body=no"])`,
      errors: [apiWrite]
    },
    {
      name: "--raw-field",
      code: `capture("gh", ["api", "repos/o/r/issues/1/comments", "--raw-field", "body=no"])`,
      errors: [apiWrite]
    },
    {
      name: "--input",
      code: `capture("gh", ["api", "repos/o/r/issues/1/comments", "--input", "-"])`,
      errors: [apiWrite]
    }
  ]
})
