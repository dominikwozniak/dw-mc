import { assert, describe, it } from "@effect/vitest"
import { Yaml } from "effect/unstable/encoding"

import type { Value } from "#adapters/yaml.ts"
import { encodeYaml } from "#adapters/yaml.ts"

const roundTrip = (value: Value) => Yaml.parse(encodeYaml(value))

describe("encodeYaml", () => {
  it("writes a mapping one key per line", () => {
    assert.strictEqual(
      encodeYaml({ base: null, rebase: { enabled: false } }),
      "base: null\nrebase:\n  enabled: false\n"
    )
  })

  it("leaves a word-like scalar unquoted and quotes anything else", () => {
    assert.strictEqual(
      encodeYaml({ effort: "low", branch: "release/2.x", glob: "**/*.md", empty: "" }),
      `effort: low\nbranch: release/2.x\nglob: "**/*.md"\nempty: ""\n`
    )
  })

  it("quotes a word YAML would otherwise read as a boolean or a null", () => {
    assert.deepStrictEqual(roundTrip({ a: "no", b: "true", c: "null", d: "~" }), {
      a: "no",
      b: "true",
      c: "null",
      d: "~"
    })
  })

  it("writes an empty collection inline and a full one as a block", () => {
    assert.strictEqual(
      encodeYaml({ ignore: [], reviewers: ["builtin"], repos: {} }),
      "ignore: []\nreviewers:\n  - builtin\nrepos: {}\n"
    )
  })

  it("writes a sequence of mappings the parser reads back whole", () => {
    const value = {
      reviewers: [
        { path: "src/**", note: "Prefer Effect.gen" },
        { path: "docs/**", note: "Present tense" }
      ]
    }

    assert.strictEqual(
      encodeYaml(value),
      "reviewers:\n" +
        `  - path: "src/**"\n` +
        '    note: "Prefer Effect.gen"\n' +
        `  - path: "docs/**"\n` +
        '    note: "Present tense"\n'
    )
    assert.deepStrictEqual(roundTrip(value), value)
  })

  it("indents a mapping nested inside a sequence item under its own key", () => {
    const value = { runs: [{ head: "cafe", verdict: { stamp: true, findings: [] } }] }

    assert.deepStrictEqual(roundTrip(value), value)
  })

  it("round-trips the shape of a whole configuration file", () => {
    const value = {
      defaults: {
        base: null,
        review: {
          command: "/code-review",
          effort: "low",
          prompt: null,
          model: null,
          docs_only: ["**/*.md", "docs/**"]
        },
        ci: { ignore: [], flaky_patterns: [] },
        rebase: { enabled: false },
        stamp: { blocks_on: "error" }
      },
      repos: { "dominikwozniak/dw-mc": { review: { effort: "high" } } }
    }

    assert.deepStrictEqual(roundTrip(value), value)
  })
})
