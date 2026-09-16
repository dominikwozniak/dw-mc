import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"

import { builtIn } from "#adapters/config.ts"
import type { ReviewRun } from "#domain/review.ts"
import {
  latestKey,
  reportDocument,
  reportedBy,
  reportKey,
  runKey,
  runnerFor,
  skippedSince,
  worthRerunning
} from "#domain/review.ts"

const run: ReviewRun = {
  repo: "dominikwozniak/dw-mc",
  number: 28,
  head: "284d599022a55d4dcae74b31b9a49a0f50061014",
  runner: "builtin",
  effort: "low",
  sessionId: "d111a7b1-a1ef-45e5-a160-68ca50a65260",
  ranAt: DateTime.makeUnsafe("2026-09-16T14:21:00Z"),
  outcome: { _tag: "reported", verdict: "clean", findings: [] }
}

describe("review run", () => {
  it("keys a run to the head it covers", () => {
    assert.strictEqual(runKey(run.repo, run.number, run.head), `dominikwozniak/dw-mc#28@${run.head}`)
    assert.notStrictEqual(runKey(run.repo, run.number, "another-head"), runKey(run.repo, run.number, run.head))
  })

  it("keeps the report beside the run it came from", () => {
    assert.strictEqual(reportKey(run.repo, run.number, run.head), `${runKey(run.repo, run.number, run.head)}.md`)
  })

  it("keys the head last reviewed to the pull request, not to a head", () => {
    assert.strictEqual(latestKey(run.repo, run.number), "dominikwozniak/dw-mc#28@latest")
    assert.notStrictEqual(latestKey(run.repo, run.number), runKey(run.repo, run.number, run.head))
  })

  it("says what the report is of, above the report", () => {
    const document = reportDocument(run, "build(lint): hold the ADR invariants", "One finding, on src/cli/cli.ts:12.")

    assert.deepStrictEqual(document.split("\n"), [
      "# dominikwozniak/dw-mc#28 build(lint): hold the ADR invariants",
      "",
      "- head: 284d599022a55d4dcae74b31b9a49a0f50061014",
      "- runner: builtin, effort low",
      "- ran: 2026-09-16T14:21:00.000Z",
      "",
      "One finding, on src/cli/cli.ts:12.",
      ""
    ])
  })
})

describe("the runner a review run executes on", () => {
  it("is the built-in one, which is the only one built", () => {
    assert.strictEqual(runnerFor(["builtin"]), "builtin")
    assert.strictEqual(runnerFor(["prompt", "builtin"]), "builtin")
  })

  it("is none at all where the configured runners are not built", () => {
    assert.strictEqual(runnerFor(["prompt"]), null)
    assert.strictEqual(runnerFor([]), null)
  })
})

describe("what a run reported", () => {
  it("is the verdict and the findings of a run that reported", () => {
    assert.deepStrictEqual(reportedBy(run), { verdict: "clean", findings: [] })
  })

  it("is nothing at all for a run that failed, which is not a clean verdict", () => {
    assert.strictEqual(reportedBy({ ...run, outcome: { _tag: "failed", detail: "it exited 1" } }), null)
  })
})

describe("the re-run rule", () => {
  const docsOnly = builtIn.review.docs_only
  const before = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"
  const last: ReviewRun = { ...run, head: before }
  const asked = (changed: ReadonlyArray<string> | null) => ({ last, head: run.head, changed })

  it("skips a run where only documentation changed since the last one", () => {
    assert.strictEqual(skippedSince(asked(["README.md", "docs/adr/0006-source-layout.md"]), docsOnly), before)
  })

  it("runs where anything outside the globs changed", () => {
    assert.strictEqual(skippedSince(asked(["README.md", "src/cli/review.ts"]), docsOnly), null)
  })

  it("skips a head that has already had a run, whatever a comparison would say", () => {
    assert.strictEqual(skippedSince({ last, head: before, changed: null }, docsOnly), before)
  })

  it("runs where the pull request has had no run to measure from", () => {
    assert.strictEqual(skippedSince({ last: null, head: run.head, changed: [] }, docsOnly), null)
  })

  it("runs where the last run reported nothing, so no code was reviewed twice", () => {
    const failed: ReviewRun = { ...last, outcome: { _tag: "failed", detail: "it exited 1" } }

    assert.strictEqual(skippedSince({ last: failed, head: run.head, changed: ["README.md"] }, docsOnly), null)
  })

  it("runs where GitHub would not say what changed, rather than trapping me", () => {
    assert.strictEqual(skippedSince(asked(null), docsOnly), null)
  })
})

describe("what the re-run rule counts as worth another run", () => {
  const docsOnly = builtIn.review.docs_only

  it("is anything outside the documentation globs", () => {
    assert.isTrue(worthRerunning(["README.md", "src/cli/review.ts"], docsOnly))
    assert.isTrue(worthRerunning(["package.json"], docsOnly))
  })

  it("is not documentation alone", () => {
    assert.isFalse(worthRerunning(["README.md", "docs/adr/0006-source-layout.md", "docs/diagram.png"], docsOnly))
  })

  it("is not nothing at all", () => {
    assert.isFalse(worthRerunning([], docsOnly))
  })

  it("is whatever the repository's own globs leave out, so a repository can widen them", () => {
    assert.isTrue(worthRerunning(["docs/adr/0006-source-layout.md"], []))
    assert.isFalse(worthRerunning(["src/cli/review.ts"], ["src/**"]))
  })
})
