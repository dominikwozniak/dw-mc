import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"

import { builtIn } from "#adapters/config.ts"
import type { ReviewRun } from "#domain/review.ts"
import { latestKey, reportDocument, reportKey, runKey, runnerFor, worthRerunning } from "#domain/review.ts"

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

describe("the re-run rule", () => {
  const docsOnly = builtIn.review.docs_only

  it("does not repeat a run when only documentation changed", () => {
    assert.isFalse(worthRerunning(["README.md", "docs/adr/0006-source-layout.md", "docs/diagram.png"], docsOnly))
  })

  it("repeats a run when anything outside the globs changed", () => {
    assert.isTrue(worthRerunning(["README.md", "src/cli/review.ts"], docsOnly))
    assert.isTrue(worthRerunning(["package.json"], docsOnly))
  })

  it("does not repeat a run when nothing changed at all", () => {
    assert.isFalse(worthRerunning([], docsOnly))
  })

  it("takes the globs from the repository, so a repository can widen them", () => {
    assert.isTrue(worthRerunning(["docs/adr/0006-source-layout.md"], []))
    assert.isFalse(worthRerunning(["src/cli/review.ts"], ["src/**"]))
  })
})
