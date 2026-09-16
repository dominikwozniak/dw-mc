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

/** Which of the three signals fired, and on what. */
export interface Signals {
  /** The workflow that is red on the default branch too, or null where none is. */
  readonly redOnDefaultBranch: string | null
  /** The changed file the log names, or null where it names none. */
  readonly namesChangedFile: string | null
  /** The flaky pattern the log matches, or null where it matches none. */
  readonly flakyPattern: string | null
}

/** What the classifier decided, and the sentence that says why. */
export interface Verdict {
  readonly classification: Classification
  readonly reason: string
  readonly signals: Signals
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
const namedChangedFile = (log: string, changedFiles: ReadonlyArray<string>): string | null =>
  changedFiles.find((file) => log.includes(file)) ?? changedFiles.find((file) => log.includes(baseName(file))) ?? null

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
  const signals: Signals = {
    redOnDefaultBranch: evidence.alsoRedOnDefaultBranch[0] ?? null,
    namesChangedFile: namedChangedFile(evidence.log, evidence.changedFiles),
    flakyPattern: matchedPattern(evidence.log, flakyPatterns)
  }

  if (signals.namesChangedFile !== null) {
    return {
      classification: "legitimate",
      reason: `the log names ${signals.namesChangedFile}, which this PR changes`,
      signals
    }
  }

  const excuses = [
    signals.redOnDefaultBranch === null ? null : `${signals.redOnDefaultBranch} is red on the default branch too`,
    signals.flakyPattern === null ? null : `the log matches "${signals.flakyPattern}"`
  ].filter((it) => it !== null)

  return excuses.length === 0
    ? { classification: "legitimate", reason: "nothing explains the failure", signals }
    : { classification: "flaky", reason: excuses.join(", and "), signals }
}
