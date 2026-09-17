import { assert, describe, it } from "@effect/vitest"

import type { Reviewing } from "#domain/persona.ts"
import { reviewPrompt, turnFor } from "#domain/persona.ts"

const reviewing: Reviewing = {
  repo: "dominikwozniak/dw-mc",
  number: 28,
  title: "build(lint): hold the ADR invariants",
  base: "main",
  prompt: null
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

  it("passes my own instructions through as its first line, untouched", () => {
    const prompt = reviewPrompt({ ...reviewing, prompt: "/review --thorough" })

    assert.isTrue(prompt.startsWith("/review --thorough\n"))
  })

  it("says nothing about instructions where the repository configured none", () => {
    assert.notInclude(reviewPrompt(reviewing), "instructions")
  })
})

describe("what a review run opens on", () => {
  it("is the slash command with the effort word after it", () => {
    const turn = turnFor({ command: "/code-review", effort: "xhigh", prompt: null }, reviewing)

    assert.deepStrictEqual(turn, { _tag: "command", line: "/code-review xhigh", instructions: null })
  })

  it("is the command alone where the repository spells its own arguments out", () => {
    const turn = turnFor({ command: "/code-review ultra", effort: null, prompt: null }, reviewing)

    assert.deepStrictEqual(turn, { _tag: "command", line: "/code-review ultra", instructions: null })
  })

  it("carries my own instructions beside the command rather than inside the persona", () => {
    const turn = turnFor({ command: "/code-review", effort: "low", prompt: "Look at the N+1 queries." }, reviewing)

    assert.strictEqual(turn._tag === "command" ? turn.instructions : null, "Look at the N+1 queries.")
  })

  it("is the tool's own prompt where no command is configured, with my instructions in front", () => {
    const turn = turnFor({ command: null, effort: "low", prompt: "Look at the N+1 queries." }, reviewing)

    assert.strictEqual(turn._tag, "prompt")
    assert.isTrue(turn._tag === "prompt" && turn.text.startsWith("Look at the N+1 queries.\n"))
    assert.include(turn._tag === "prompt" ? turn.text : "", "experienced staff engineer")
  })

  it("is the persona alone where nothing at all is configured", () => {
    const turn = turnFor({ command: null, effort: null, prompt: null }, reviewing)

    assert.strictEqual(turn._tag, "prompt")
    assert.isTrue(turn._tag === "prompt" && turn.text.startsWith("You are an experienced staff engineer"))
  })
})
