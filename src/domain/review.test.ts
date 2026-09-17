import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"

import { builtIn } from "#adapters/config.ts"
import type { ReviewRun } from "#domain/review.ts"
import {
  blockingIn,
  decidingIn,
  latestKey,
  reportDocument,
  reportedBy,
  reportKey,
  reviewedBy,
  runKey,
  runnersFor,
  skippedSince,
  supportingIn,
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
  it("keys a run to the head it covers and the runner that read it", () => {
    assert.strictEqual(runKey(run.repo, run.number, run.head, "builtin"), `dominikwozniak/dw-mc#28@${run.head}:builtin`)
    assert.notStrictEqual(
      runKey(run.repo, run.number, "another-head", "builtin"),
      runKey(run.repo, run.number, run.head, "builtin")
    )
  })

  it("keeps a second opinion at the same head apart from the review it stands beside", () => {
    assert.notStrictEqual(
      runKey(run.repo, run.number, run.head, "codex"),
      runKey(run.repo, run.number, run.head, "prompt")
    )
  })

  it("keeps the report beside the run it came from", () => {
    assert.strictEqual(
      reportKey(run.repo, run.number, run.head, "builtin"),
      `${runKey(run.repo, run.number, run.head, "builtin")}.md`
    )
  })

  it("keys the head last reviewed to the pull request and the runner, not to a head", () => {
    assert.strictEqual(latestKey(run.repo, run.number, "builtin"), "dominikwozniak/dw-mc#28@latest:builtin")
    assert.notStrictEqual(latestKey(run.repo, run.number, "builtin"), runKey(run.repo, run.number, run.head, "builtin"))
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

describe("the runners a review run executes", () => {
  it("are the configured ones, in the order the file names them", () => {
    assert.deepStrictEqual(runnersFor(["prompt", "codex"]), ["prompt", "codex"])
    assert.deepStrictEqual(runnersFor(["codex", "builtin"]), ["codex", "builtin"])
  })

  it("are named once however often the file names them", () => {
    assert.deepStrictEqual(runnersFor(["prompt", "prompt", "codex"]), ["prompt", "codex"])
  })

  it("are none at all where the file configured none", () => {
    assert.deepStrictEqual(runnersFor([]), [])
  })
})

describe("the second opinion", () => {
  it("is Codex, wherever a review of my own runs beside it", () => {
    assert.deepStrictEqual(supportingIn(["prompt", "codex"]), ["codex"])
    assert.deepStrictEqual(supportingIn(["builtin", "codex"]), ["codex"])
  })

  it("is nothing where Codex is the review rather than a second opinion", () => {
    assert.deepStrictEqual(supportingIn(["codex"]), [])
  })

  it("does not decide the stamp until the configuration says it does", () => {
    assert.deepStrictEqual(decidingIn(["prompt", "codex"], false), ["prompt"])
    assert.deepStrictEqual(decidingIn(["prompt", "codex"], true), ["prompt", "codex"])
  })

  it("decides the stamp where it is the only runner configured", () => {
    assert.deepStrictEqual(decidingIn(["codex"], false), ["codex"])
  })
})

describe("whether a head has the review it needs", () => {
  const reported = (runner: ReviewRun["runner"]): ReviewRun => ({ ...run, runner })
  const failed = (runner: ReviewRun["runner"]): ReviewRun => ({
    ...run,
    runner,
    outcome: { _tag: "failed", detail: "it exited 1" }
  })

  it("is true once every deciding runner has reported on it", () => {
    assert.isTrue(reviewedBy([reported("prompt"), reported("codex")], ["prompt", "codex"]))
  })

  it("is false while one of them has not", () => {
    assert.isFalse(reviewedBy([reported("prompt")], ["prompt", "codex"]))
  })

  it("ignores a run that reported nothing, which found nothing rather than nothing wrong", () => {
    assert.isFalse(reviewedBy([failed("prompt")], ["prompt"]))
  })

  it("ignores a second opinion that does not decide", () => {
    assert.isTrue(reviewedBy([reported("prompt"), failed("codex")], ["prompt"]))
  })

  it("is false where nothing decides, so no stamp rests on an empty configuration", () => {
    assert.isFalse(reviewedBy([reported("prompt")], []))
  })
})

describe("the findings that withhold the stamp", () => {
  const found = (runner: ReviewRun["runner"], severity: "error" | "warning"): ReviewRun => ({
    ...run,
    runner,
    outcome: {
      _tag: "reported",
      verdict: "findings",
      findings: [{ file: "src/cli/review.ts", line: 88, severity, summary: "The run is never recorded." }]
    }
  })

  it("are the deciding runners' findings at or above the bar", () => {
    assert.lengthOf(blockingIn([found("prompt", "error")], ["prompt"], "error"), 1)
    assert.lengthOf(blockingIn([found("prompt", "warning")], ["prompt"], "error"), 0)
    assert.lengthOf(blockingIn([found("prompt", "warning")], ["prompt"], "warning"), 1)
  })

  it("leave a second opinion's findings out until it decides", () => {
    const runs = [found("prompt", "warning"), found("codex", "error")]

    assert.lengthOf(blockingIn(runs, ["prompt"], "error"), 0)
    assert.lengthOf(blockingIn(runs, ["prompt", "codex"], "error"), 1)
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
