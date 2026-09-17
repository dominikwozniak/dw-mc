import type { ESTree } from "@oxlint/plugins"
import { defineRule } from "@oxlint/plugins"

/**
 * Every `gh` invocation dw-mc is allowed to make.
 *
 * An entry matches when it is a prefix of the argument vector, so `api` covers
 * every endpoint and `pr view` covers whatever flags follow it. This list is the
 * whole boundary: admitting a read is one line here with a diff someone can
 * read, and anything not listed is refused, so a verb nobody has thought about
 * yet waits to be read rather than arriving by silence.
 */
const reads: ReadonlyArray<ReadonlyArray<string>> = [
  /** The spawner's own test spawns it, and it reads nothing but the local binary. */
  ["--version"],
  ["api"],
  ["auth", "status"],
  ["pr", "list"],
  ["pr", "view"],
  ["repo", "view"],
  ["run", "list"],
  ["search", "prs"]
]

/** What turns `gh api` from a read into a write, whatever endpoint it names. */
const apiWriteFlags = ["-X", "--method", "-f", "--field", "-F", "--raw-field", "--input"]

/** What a vector that does not spell its verb out is called in a diagnostic. */
const unreadable = "A `gh` argument vector this rule cannot read"

const stringValue = (node: ESTree.Node): string | undefined =>
  node.type === "Literal" && typeof node.value === "string" ? node.value : undefined

/**
 * The leading words a vector spells out.
 *
 * A vector stops being readable at its first computed element, and what follows
 * cannot decide the verb, so the prefix is the whole question. Every `gh` vector
 * in this repository spells its verb out.
 */
const leadingWords = (vector: ESTree.ArrayExpression): ReadonlyArray<string> => {
  const words: Array<string> = []
  for (const element of vector.elements) {
    if (element === null) {
      break
    }
    const word = stringValue(element)
    if (word === undefined) {
      break
    }
    words.push(word)
  }
  return words
}

const isRead = (words: ReadonlyArray<string>): boolean =>
  reads.some((read) => read.every((word, index) => words[index] === word))

/**
 * The first write flag the vector carries, in the spelling it was written in.
 *
 * Flags arrive after the endpoint, which is a template literal in most reads
 * here, so this looks at every spelled-out element rather than the prefix. A
 * short flag takes its value attached (`-XPOST`) as readily as apart.
 */
const writeFlag = (vector: ESTree.ArrayExpression): string | undefined => {
  for (const element of vector.elements) {
    if (element === null) {
      continue
    }
    const word = stringValue(element)
    if (word === undefined) {
      continue
    }
    const carries = apiWriteFlags.some(
      (flag) => word === flag || word.startsWith(`${flag}=`) || (flag.length === 2 && word.startsWith(flag))
    )
    if (carries) {
      return word
    }
  }
  return undefined
}

/**
 * ADR 0002's write boundary, held against the vector handed to `gh`.
 *
 * A call carrying the string `"gh"` is a `gh` invocation, and its array literals
 * are the vectors it hands over. One spelling is out of reach: a `gh` bound to a
 * variable first, which would take the scope analysis this rule is thin for
 * avoiding. Nothing in `src/` is written that way, and a call that hands `gh` a
 * vector assembled elsewhere is refused rather than followed.
 */
export const noGhWritesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Allow only the `gh` reads dw-mc makes, and reject every other argument vector handed to `gh`."
    },
    messages: {
      notARead:
        "{{invocation}} is not one of the reads dw-mc makes. Mission control never comments, replies, resolves a thread, labels, reviews, approves, changes a status or merges (ADR 0002), and v1 makes no GitHub write at all. A read that belongs here is a line in `reads` in this rule.",
      apiWrite:
        "`gh api` carrying `{{flag}}` sends a write, and ADR 0002 leaves dw-mc none to send. The REST endpoint is not a way around the boundary."
    }
  },
  createOnce(context) {
    const checkVector = (vector: ESTree.ArrayExpression) => {
      const words = leadingWords(vector)
      if (!isRead(words)) {
        context.report({
          node: vector,
          messageId: "notARead",
          data: {
            invocation: words.length > 0 ? `\`gh ${words.join(" ")}\`` : unreadable
          }
        })
        return
      }
      if (words[0] !== "api") {
        return
      }
      const flag = writeFlag(vector)
      if (flag !== undefined) {
        context.report({ node: vector, messageId: "apiWrite", data: { flag } })
      }
    }

    return {
      CallExpression(node) {
        if (!node.arguments.some((argument) => stringValue(argument) === "gh")) {
          return
        }
        const vectors = node.arguments.filter((argument) => argument.type === "ArrayExpression")
        if (vectors.length === 0) {
          context.report({ node, messageId: "notARead", data: { invocation: unreadable } })
          return
        }
        for (const vector of vectors) {
          checkVector(vector)
        }
      }
    }
  }
})
