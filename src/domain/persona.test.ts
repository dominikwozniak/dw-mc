import { assert, describe, it } from "@effect/vitest"

import type { Reviewing } from "#domain/persona.ts"
import { reviewPrompt } from "#domain/persona.ts"

const reviewing: Reviewing = {
  repo: "dominikwozniak/dw-mc",
  number: 28,
  title: "build(lint): hold the ADR invariants",
  base: "main",
  skill: null
}

describe("the review prompt", () => {
  it("says which change is under review and what it is measured against", () => {
    const prompt = reviewPrompt(reviewing)

    assert.include(prompt, `dominikwozniak/dw-mc#28, "build(lint): hold the ADR invariants"`)
    assert.include(prompt, "git diff main...HEAD")
  })

  it("carries the persona's five dimensions", () => {
    const prompt = reviewPrompt(reviewing)

    for (const dimension of ["Correctness", "Readability", "Architecture", "Security", "Performance"]) {
      assert.include(prompt, dimension)
    }
  })

  it("maps the persona's own words onto the three severities the schema has", () => {
    const prompt = reviewPrompt(reviewing)

    assert.include(prompt, "Critical, which blocks the merge")
    assert.include(prompt, "is reported as error")
    assert.include(prompt, "Optional, which is worth considering and not required")
    assert.include(prompt, "reported as warning")
    assert.include(prompt, "Nit")
    assert.include(prompt, "FYI")
    assert.include(prompt, "reported as info")
  })

  it("asks for structured output rather than a report to parse", () => {
    assert.include(reviewPrompt(reviewing), "Answer as structured output")
  })

  it("passes a repository's own review skill through as its first line, untouched", () => {
    const prompt = reviewPrompt({ ...reviewing, skill: "/review --thorough" })

    assert.isTrue(prompt.startsWith("/review --thorough\n"))
  })

  it("says nothing about a skill where the repository configured none", () => {
    assert.notInclude(reviewPrompt(reviewing), "skill")
  })
})
