import { RuleTester } from "oxlint/plugins-dev"

import { noGhWritesRule } from "./no-gh-writes.ts"

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })
const notARead = { messageId: "notARead" }
const apiWrite = { messageId: "apiWrite" }
const writeNeedsFlag = { messageId: "writeNeedsFlag" }
const writeForbidsFlag = { messageId: "writeForbidsFlag" }
const graphqlUnreadable = { messageId: "graphqlUnreadable" }
const graphqlBody = { messageId: "graphqlBody" }
const graphqlMutation = { messageId: "graphqlMutation" }

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
      name: "the write ADR 0002 admits",
      code: `capture("gh", ["run", "rerun", runId, "--repo", repo, "--failed"])`
    },
    {
      name: "the write ADR 0008 admits",
      code: `capture("gh", ["pr", "merge", String(number), "--repo", repo, "--squash", "--delete-branch"])`
    },
    {
      name: "the GraphQL read a thread's resolution only arrives through",
      code: 'readJson("api graphql", "gh", ["api", "graphql", "-f", `query=query($n:Int!){x}`, "-F", `n=${n}`], C)'
    },
    {
      name: "another program's vector is not this rule's business",
      code: `capture("git", ["push", "--force-with-lease"])`
    }
  ],
  invalid: [
    {
      name: "a merge that leaves the branch behind, which is not the write that was admitted",
      code: `capture("gh", ["pr", "merge", "27", "--squash"])`,
      errors: [writeNeedsFlag]
    },
    {
      name: "a merge GitHub makes later, at a head nothing here has read",
      code: `capture("gh", ["pr", "merge", "27", "--auto", "--squash", "--delete-branch"])`,
      errors: [writeForbidsFlag]
    },
    { name: "a write verb", code: `capture("gh", ["pr", "close", "27"])`, errors: [notARead] },
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
      name: "a GraphQL mutation, which resolves the thread ADR 0002 says nothing here resolves",
      code: 'readJson("api graphql", "gh", ["api", "graphql", "-f", `query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){clientMutationId}}`], C)',
      errors: [graphqlMutation]
    },
    {
      name: "a GraphQL document assembled at runtime, which this rule cannot read",
      code: 'readJson("api graphql", "gh", ["api", "graphql", "-f", `query=${document}`], C)',
      errors: [graphqlUnreadable]
    },
    {
      name: "a GraphQL call with no document at all",
      code: 'readJson("api graphql", "gh", ["api", "graphql", "-F", `number=${number}`], C)',
      errors: [graphqlUnreadable]
    },
    {
      name: "a GraphQL call carrying a body this rule has not read",
      code: 'capture("gh", ["api", "graphql", "--input", "-"])',
      errors: [graphqlBody]
    },
    {
      name: "--input",
      code: `capture("gh", ["api", "repos/o/r/issues/1/comments", "--input", "-"])`,
      errors: [apiWrite]
    }
  ]
})
