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

/**
 * Every `gh` write dw-mc is allowed to make, and the flags that keep each one
 * inside the boundary.
 *
 * There are two here, and the label writes in `apiWrites`. ADR 0002 admits re-running the failed jobs of a workflow run
 * on a pull request I author; ADR 0008 admits squash-merging a pull request I
 * author and deleting the branch it stood on.
 *
 * The flags are part of the entry rather than an afterthought, because each of
 * them is what makes the call the write that was admitted: `--failed` is what
 * keeps a re-run off the jobs that passed, and `--squash --delete-branch` is
 * the merge this repository lands, spelled out.
 *
 * `--auto` is refused outright rather than left unlisted. It turns a merge into
 * one GitHub makes later, at a head nothing here has read, and every verdict in
 * this tool is about one head (ADR 0008).
 */
interface Write {
  readonly prefix: ReadonlyArray<string>
  readonly requires: ReadonlyArray<string>
  readonly forbids?: ReadonlyArray<string>
}

const writes: ReadonlyArray<Write> = [
  { prefix: ["run", "rerun"], requires: ["--failed"] },
  { prefix: ["pr", "merge"], requires: ["--squash", "--delete-branch"], forbids: ["--auto"] }
]

/**
 * Every `gh api` write dw-mc is allowed to make, spelled out whole.
 *
 * There are two, and they are one write: ADR 0012 admits putting the review
 * label on a pull request I author and taking it off again. Each is the whole
 * vector and not a prefix, because the endpoint and the field are what make it
 * that write: a `-X POST` to any other path, or with a field beside the label,
 * is a different call. `{}` stands for what a template literal substitutes, the
 * repository, the number and the label's name.
 */
const apiWrites: ReadonlyArray<ReadonlyArray<string>> = [
  ["api", "-X", "POST", "repos/{}/issues/{}/labels", "-f", "labels[]={}"],
  ["api", "-X", "DELETE", "repos/{}/issues/{}/labels/{}"]
]

/** What turns `gh api` from a read into a write, whatever endpoint it names. */
const apiWriteFlags = ["-X", "--method", "-f", "--field", "-F", "--raw-field", "--input"]

/**
 * What turns `gh api graphql` into a write.
 *
 * GraphQL is one endpoint reached by POST whether it is asked to read or to
 * write, so the field flags that carry the document and its variables cannot be
 * what decides: a `reviewThreads` query and a `resolveReviewThread` mutation are
 * the same call but for the document. The document is what this rule reads
 * instead, and these are the flags that would put a body under it that this rule
 * cannot.
 */
const graphqlWriteFlags = ["-X", "--method", "--input"]

/** The flag value that carries the GraphQL document itself. */
const document = "query="

/** What a vector that does not spell its verb out is called in a diagnostic. */
const unreadable = "A `gh` argument vector this rule cannot read"

/**
 * A spelled-out string, whichever way it is quoted.
 *
 * A template literal with nothing substituted into it is as readable as a
 * quoted string and is how a document that runs over lines is written, so it
 * counts as spelled out. One with an expression in it does not: what it comes
 * to is decided at runtime.
 */
const stringValue = (node: ESTree.Node): string | undefined => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value
  }
  return node.type === "TemplateLiteral" && node.expressions.length === 0
    ? (node.quasis[0]?.value.cooked ?? undefined)
    : undefined
}

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

/**
 * An element as `apiWrites` spells it: a string as it is, a template literal
 * with `{}` where each expression goes, and anything else unreadable.
 */
const shapeOf = (node: ESTree.Node | null): string | undefined => {
  if (node === null) {
    return undefined
  }
  if (node.type === "TemplateLiteral") {
    return node.quasis.map((quasi) => quasi.value.cooked ?? "").join("{}")
  }
  return stringValue(node)
}

const isAdmittedApiWrite = (vector: ESTree.ArrayExpression): boolean => {
  const shape = vector.elements.map(shapeOf)
  return apiWrites.some((write) => write.length === shape.length && write.every((word, index) => shape[index] === word))
}

const matches = (prefix: ReadonlyArray<string>, words: ReadonlyArray<string>): boolean =>
  prefix.every((word, index) => words[index] === word)

const isRead = (words: ReadonlyArray<string>): boolean => reads.some((read) => matches(read, words))

const writeFor = (words: ReadonlyArray<string>) => writes.find((write) => matches(write.prefix, words))

/**
 * Whether the vector spells `flag` out anywhere.
 *
 * A flag sits after the arguments a write names, which are computed in every
 * call here, so this reads every spelled-out element rather than the prefix.
 */
const carriesFlag = (vector: ESTree.ArrayExpression, flag: string): boolean =>
  vector.elements.some((element) => element !== null && stringValue(element) === flag)

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
        "{{invocation}} is not one of the calls dw-mc makes. Mission control never comments, replies, resolves a thread, reviews, approves or changes a status (ADR 0002), and the only writes it sends through `gh` are re-running my own failed jobs, merging a pull request I author (ADR 0008) and moving the review label on one (ADR 0012). A call that belongs here is a line in `reads`, `writes` or `apiWrites` in this rule.",
      apiWrite:
        "`gh api` carrying `{{flag}}` sends a write ADR 0002 does not admit. The REST endpoint is not a way around the boundary: the one REST write dw-mc makes is adding or removing the review label, spelled exactly as `apiWrites` in this rule has it (ADR 0012).",
      graphqlBody:
        "`gh api graphql` carrying a method or a body of its own sends something this rule has not read. The one GraphQL call dw-mc makes spells its query out and passes its variables as fields.",
      graphqlUnreadable:
        "`gh api graphql` has to spell its document out here, as `query=...`, or this rule cannot tell a read from a write: every GraphQL call is a POST, so the document is the only thing that says which one it is.",
      graphqlMutation:
        "`gh api graphql` may only send a query. A mutation is a write ADR 0002 does not admit, and GraphQL is not a way around the boundary.",
      writeForbidsFlag:
        "{{invocation}} carrying `{{flag}}` is not the write dw-mc makes. A deferred merge happens at a head nothing here has read, and every verdict in this tool is about one head (ADR 0008).",
      writeNeedsFlag:
        "{{invocation}} is a write dw-mc admits only with `{{missing}}`. The flags are what make it the call that was admitted, so without them it is a different write from the one the boundary was drawn around."
    }
  },
  createOnce(context) {
    /**
     * A GraphQL call, judged by the document it sends.
     *
     * The document is the whole question here. It has to be spelled out, it has
     * to be a query, and nothing may put a body under it that this rule has not
     * read.
     */
    const checkGraphql = (vector: ESTree.ArrayExpression) => {
      const forbidden = vector.elements.some((element) => {
        if (element === null) {
          return false
        }
        const word = stringValue(element)
        return (
          word !== undefined &&
          graphqlWriteFlags.some((flag) => word === flag || word.startsWith(`${flag}=`) || word.startsWith("-X"))
        )
      })
      if (forbidden) {
        context.report({ node: vector, messageId: "graphqlBody" })
        return
      }

      const sent = vector.elements
        .map((element) => (element === null ? undefined : stringValue(element)))
        .find((word) => word !== undefined && word.startsWith(document))
      if (sent === undefined) {
        context.report({ node: vector, messageId: "graphqlUnreadable" })
        return
      }
      const query = sent.slice(document.length).trim()
      if (!/^query[\s({]/.test(query) || /\bmutation\b/.test(query)) {
        context.report({ node: vector, messageId: "graphqlMutation" })
      }
    }

    const checkVector = (vector: ESTree.ArrayExpression) => {
      const words = leadingWords(vector)
      const write = writeFor(words)
      if (write !== undefined) {
        const invocation = `\`gh ${words.join(" ")}\``
        const forbidden = (write.forbids ?? []).find((flag) => carriesFlag(vector, flag))
        if (forbidden !== undefined) {
          context.report({ node: vector, messageId: "writeForbidsFlag", data: { invocation, flag: forbidden } })
          return
        }
        const missing = write.requires.filter((flag) => !carriesFlag(vector, flag))
        if (missing.length > 0) {
          context.report({
            node: vector,
            messageId: "writeNeedsFlag",
            data: { invocation, missing: missing.join("` and `") }
          })
        }
        return
      }
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
      if (words[1] === "graphql") {
        checkGraphql(vector)
        return
      }
      const flag = writeFlag(vector)
      if (flag !== undefined && !isAdmittedApiWrite(vector)) {
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
