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
  ["--version"],
  ["api"],
  ["auth", "status"],
  ["pr", "view"],
  ["repo", "view"],
  ["run", "list"],
  ["search", "prs"]
]

/** What turns `gh api` from a read into a write, whatever endpoint it names. */
const apiWriteFlags = ["-X", "--method", "-f", "--field", "-F", "--raw-field", "--input"]

const stringValue = (node: ESTree.Node): string | undefined =>
  node.type === "Literal" && typeof node.value === "string" ? node.value : undefined

/**
 * The leading words a vector spells out.
 *
 * A vector stops being readable at its first computed element, and what follows
 * cannot decide the verb, so the prefix is the whole question. Every `gh` vector
 * in this repository spells its verb out.
 */
const spelledOut = (vector: ESTree.ArrayExpression): ReadonlyArray<string> => {
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

/** Mission control reads GitHub and nothing else, held against the vector handed to `gh`. */
export const noGhWritesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Allow only the `gh` reads dw-mc makes, and reject every other argument vector handed to `gh`."
    },
    messages: {
      notARead:
        "{{invocation}} is not one of the reads dw-mc makes. Mission control only reads GitHub: it never comments, replies, resolves a thread, labels, reviews, approves, changes a status or merges (ADR 0002). A read that belongs here is a line in `reads` in this rule.",
      apiWrite:
        "`gh api` carrying `{{flag}}` sends a write. Mission control only reads GitHub (ADR 0002), and the REST endpoint is not a way around that."
    }
  },
  createOnce(context) {
    const checkVector = (vector: ESTree.ArrayExpression) => {
      const words = spelledOut(vector)
      if (!isRead(words)) {
        context.report({
          node: vector,
          messageId: "notARead",
          data: {
            invocation: words.length > 0 ? `\`gh ${words.join(" ")}\`` : "A `gh` argument vector built at runtime"
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
        for (const argument of node.arguments) {
          if (argument.type === "ArrayExpression") {
            checkVector(argument)
          }
        }
      }
    }
  }
})
