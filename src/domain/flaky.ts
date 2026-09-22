import { Effect } from "effect"

import { defaultBranch, failedChecks, jobLog, prFiles, reportedAt, workflowFailsOn } from "#adapters/ci.ts"
import type { CheckEntry } from "#adapters/ci.ts"

/**
 * Everything the classifier is allowed to know about one red CI.
 *
 * All three are facts a sweep reads off GitHub, which is what keeps the verdict
 * reproducible: the same evidence always yields the same answer.
 */
export interface Evidence {
  /** The workflows failing here that are failing on the default branch as well. */
  readonly alsoRedOnDefaultBranch: ReadonlyArray<string>
  /** The files the pull request changes, as repository paths. */
  readonly changedFiles: ReadonlyArray<string>
  /** What the failing jobs printed. */
  readonly log: string
}

/** Whether a red CI is mine to fix. */
export type Classification = "flaky" | "legitimate"

/** What the classifier decided, and the sentence that says why. */
export interface Verdict {
  readonly classification: Classification
  readonly reason: string
}

/**
 * The failures that are flaky wherever they appear: a machine, a network or a
 * runner giving up, never a test disagreeing with the code.
 *
 * `ci.flaky_patterns` adds to this list rather than replacing it, because the
 * failures a repository of mine produces are extra ones, not different ones.
 */
export const builtInPatterns: ReadonlyArray<string> = [
  "timed out",
  "deadline exceeded",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "connection refused",
  "socket hang up",
  "lock timeout",
  "could not obtain lock",
  "runner lost communication",
  "The runner has received a shutdown signal",
  "net/http: request canceled",
  "ResourceExhausted",
  "Too many open files",
  "no space left on device"
]

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

/**
 * The changed file the log names, preferring one it spells in full.
 *
 * A bare file name is worth matching - a stack trace often prints nothing else
 * - and it is worth matching second, because a name as ordinary as `index.ts`
 * belongs to more repositories than mine.
 */
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Whether the log names a file called `base` rather than some longer name
 * ending in it: a changed `src/a.ts` is not what a log printing `data.ts` is
 * complaining about.
 */
const namesFile = (log: string, base: string): boolean => new RegExp(`(^|[^\\w.-])${escaped(base)}`).test(log)

const namedChangedFile = (log: string, changedFiles: ReadonlyArray<string>): string | null =>
  changedFiles.find((file) => log.includes(file)) ?? changedFiles.find((file) => namesFile(log, baseName(file))) ?? null

/**
 * The flaky pattern the log matches, mine before the built-in ones.
 *
 * A pattern is text and not a regular expression: it comes out of a
 * configuration file I edit by hand, where a stray `*` should cost me a missed
 * match and never a crash.
 */
const matchedPattern = (log: string, patterns: ReadonlyArray<string>): string | null => {
  const haystack = log.toLowerCase()
  return [...patterns, ...builtInPatterns].find((pattern) => haystack.includes(pattern.toLowerCase())) ?? null
}

/**
 * Whether a red CI is mine to fix, and why.
 *
 * Two of the signals say flaky and one says legitimate, and the one outranks
 * the two: a log that names a file this pull request changes is the failure
 * pointing at my own work, and a workflow that is broken everywhere does not
 * stop it pointing there.
 *
 * Everything else that is unexplained is mine as well. The two mistakes do not
 * cost the same - a real failure called flaky is a broken pull request nobody
 * tells me about, while a flake called mine costs me one look - so the default
 * is the one I can recover from.
 */
export const classify = (evidence: Evidence, flakyPatterns: ReadonlyArray<string>): Verdict => {
  const named = namedChangedFile(evidence.log, evidence.changedFiles)
  if (named !== null) {
    return { classification: "legitimate", reason: `the log names ${named}, which this PR changes` }
  }

  const redOnDefaultBranch = evidence.alsoRedOnDefaultBranch[0]
  const pattern = matchedPattern(evidence.log, flakyPatterns)
  const excuses = [
    redOnDefaultBranch === undefined ? null : `${redOnDefaultBranch} is red on the default branch too`,
    pattern === null ? null : `the log matches "${pattern}"`
  ].filter((it) => it !== null)

  return excuses.length === 0
    ? { classification: "legitimate", reason: "nothing explains the failure" }
    : { classification: "flaky", reason: excuses.join(", and ") }
}

/**
 * How many failing jobs the log is read from.
 *
 * One broken workflow usually fails several jobs with the same cause, and the
 * logs are the one read here that is measured in megabytes.
 */
const loggedJobs = 3

/** The values of `xs` that `f` has one for. */
const filterMap = <A, B>(xs: ReadonlyArray<A>, f: (a: A) => B | null): ReadonlyArray<B> =>
  xs.flatMap((x) => {
    const b = f(x)
    return b === null ? [] : [b]
  })

/** No evidence at all, which is what an unreadable CI comes to. */
const nothing: Evidence = { alsoRedOnDefaultBranch: [], changedFiles: [], log: "" }

/**
 * What a red CI looks like to the classifier.
 *
 * A read that fails costs its own signal and nothing else. GitHub drops an
 * Actions log after ninety days, so a pull request open that long would
 * otherwise lose its row over a log nobody can fetch any more - and a missing
 * signal only ever moves the verdict towards legitimate, which is the answer
 * that puts the pull request in front of me rather than hiding it.
 */
export const evidenceFor = Effect.fn("flaky.evidenceFor")(function* (
  repo: string,
  number: number,
  entries: ReadonlyArray<CheckEntry> | null,
  ignore: ReadonlyArray<string>
) {
  const failed = failedChecks(entries, ignore)
  const workflows = [...new Set(filterMap(failed, (check) => check.workflowName ?? null))]
  const jobs = filterMap(failed, (check) => reportedAt(check.detailsUrl)?.job ?? null).slice(0, loggedJobs)

  const branch = yield* Effect.orElseSucceed(defaultBranch(repo), () => null)
  if (branch === null) {
    return nothing
  }

  const [alsoRed, changedFiles, logs] = yield* Effect.all(
    [
      Effect.forEach(workflows, (workflow) =>
        Effect.map(
          Effect.orElseSucceed(workflowFailsOn(repo, branch, workflow), () => false),
          (red) => (red ? [workflow] : [])
        )
      ),
      Effect.orElseSucceed(prFiles(repo, number), (): ReadonlyArray<string> => []),
      Effect.forEach(jobs, (job) => Effect.orElseSucceed(jobLog(repo, job), () => ""))
    ],
    { concurrency: 3 }
  )

  return { alsoRedOnDefaultBranch: alsoRed.flat(), changedFiles, log: logs.join("\n") } satisfies Evidence
})

/**
 * Why a red CI is excused, or null where it is mine to fix.
 *
 * Reading the evidence and classifying it is one act, so it is one function:
 * a sweep writes what it returns down as `ciFlaky`, and `dw-mc rerun` asks it
 * again live. Two callers asking the same question have to get the same answer,
 * which they cannot if each of them spells the question out.
 */
export const flakyReason = Effect.fn("flaky.flakyReason")(function* (
  repo: string,
  number: number,
  entries: ReadonlyArray<CheckEntry> | null,
  ignore: ReadonlyArray<string>,
  patterns: ReadonlyArray<string>
) {
  const verdict = classify(yield* evidenceFor(repo, number, entries, ignore), patterns)
  return verdict.classification === "flaky" ? verdict.reason : null
})
