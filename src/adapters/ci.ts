import { Effect, Schema } from "effect"

import type { CheckEntry } from "#adapters/gh.ts"
import { GhReadFailed, readJson, unavailable } from "#adapters/gh.ts"
import { capture } from "#adapters/spawner.ts"

/**
 * What GitHub says about a pull request's checks, and the evidence a red one
 * is classified on. Every read here goes through the same `gh` the rest of the
 * tool does; what it owns is the checks, not the boundary.
 */

const failing = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"])
const running = new Set(["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED", "EXPECTED"])

const nameOf = (entry: CheckEntry): string => entry.name ?? entry.context ?? ""

const checksThatCount = (entries: ReadonlyArray<CheckEntry> | null, ignore: ReadonlyArray<string>) =>
  (entries ?? []).filter((entry) => !ignore.includes(nameOf(entry)))

const hasFailed = (entry: CheckEntry): boolean => failing.has(entry.conclusion ?? "") || failing.has(entry.state ?? "")

/**
 * What the rollup comes to: red when anything failed, pending only while
 * nothing has failed yet, green when every check that counts has passed.
 *
 * `ci.ignore` names the checks that do not count towards green, so a check I
 * have decided to live with cannot hold a PR out of Ready.
 */
export const rollupState = (
  entries: ReadonlyArray<CheckEntry> | null,
  ignore: ReadonlyArray<string>
): "green" | "red" | "pending" | "none" => {
  const checks = checksThatCount(entries, ignore)
  if (checks.length === 0) {
    return "none"
  }
  if (checks.some(hasFailed)) {
    return "red"
  }
  if (
    checks.some(
      (entry) => (entry.status !== undefined && entry.status !== "COMPLETED") || running.has(entry.state ?? "")
    )
  ) {
    return "pending"
  }
  return "green"
}

/**
 * The checks that failed and count, which are the ones there is a log to read.
 *
 * `ci.ignore` is applied here as well as in the rollup: a check that cannot
 * hold a PR out of Ready is not one the classifier should be explaining either.
 */
export const failedChecks = (
  entries: ReadonlyArray<CheckEntry> | null,
  ignore: ReadonlyArray<string>
): ReadonlyArray<CheckEntry> => checksThatCount(entries, ignore).filter(hasFailed)

/**
 * The job a check reports on, out of the URL it reports at.
 *
 * A check run details URL ends `/actions/runs/<run>/job/<job>`, and the job id
 * is what the logs endpoint takes. A commit status points somewhere else
 * entirely, which is null: there is no log of ours to read.
 */
export const jobIdOf = (detailsUrl: string | undefined): string | null => {
  const found = detailsUrl?.match(/\/job\/(\d+)/)
  return found?.[1] ?? null
}

const RepoDefaultBranch = Schema.fromJsonString(
  Schema.Struct({ defaultBranchRef: Schema.NullOr(Schema.Struct({ name: Schema.String })) })
)

/**
 * The branch a repository merges into, which is the one the first flaky signal
 * asks about. An empty repository has none, and `main` is the better guess than
 * failing the sweep over it.
 */
export const defaultBranch = Effect.fnUntraced(function* (repo: string) {
  const view = yield* readJson(
    "repo view defaultBranchRef",
    "gh",
    ["repo", "view", repo, "--json", "defaultBranchRef"],
    RepoDefaultBranch
  )
  return view.defaultBranchRef?.name ?? "main"
})

const Runs = Schema.fromJsonString(Schema.Array(Schema.Struct({ conclusion: Schema.String })))

/** How far back to look for a run that reached a verdict at all. */
const recentRuns = 5

/** `gh run list` reports a conclusion in lower case, unlike every check on a PR. */
const failedRun = new Set(["failure", "timed_out"])

/** A run that decided something. A skipped or cancelled run says nothing either way. */
const verdicts = new Set(["failure", "timed_out", "success"])

/**
 * Whether `workflow` is red on `branch` right now.
 *
 * The newest run that reached a verdict is the whole answer: a workflow that
 * broke last week and was fixed since is not red, and excusing a pull request
 * for it would hide a failure that is real. A handful of runs are asked for
 * because the newest ones are often skipped by a path filter.
 */
export const workflowFailsOn = Effect.fnUntraced(function* (repo: string, branch: string, workflow: string) {
  const runs = yield* readJson(
    "run list",
    "gh",
    [
      "run",
      "list",
      "--repo",
      repo,
      "--branch",
      branch,
      "--workflow",
      workflow,
      "--limit",
      String(recentRuns),
      "--json",
      "conclusion"
    ],
    Runs
  )
  // `gh run list` answers newest first.
  const newest = runs.find((run) => verdicts.has(run.conclusion))
  return newest !== undefined && failedRun.has(newest.conclusion)
})

const PrFiles = Schema.fromJsonString(Schema.Struct({ files: Schema.Array(Schema.Struct({ path: Schema.String })) }))

/** The repository paths a pull request changes. */
export const prFiles = Effect.fnUntraced(function* (repo: string, number: number) {
  const view = yield* readJson(
    "pr view files",
    "gh",
    ["pr", "view", String(number), "--repo", repo, "--json", "files"],
    PrFiles
  )
  return view.files.map((file) => file.path)
})

/**
 * How much of a failing job's log is kept.
 *
 * A job that failed prints what went wrong at the end, so the tail is the part
 * worth classifying, and a build that logged a whole dependency tree is not
 * worth holding in memory beyond it.
 */
const logTailBytes = 64 * 1024

/**
 * What one failing job printed, from the end.
 *
 * `gh api` refuses a response carrying terminal escape sequences unless it is
 * told otherwise, and a runner log is full of them. Verified by running it: the
 * endpoint answers with the plain log once the flag is passed.
 */
export const jobLog = Effect.fnUntraced(function* (repo: string, jobId: string) {
  const log = yield* capture("gh", [
    "api",
    `repos/${repo}/actions/jobs/${jobId}/logs`,
    "--allow-escape-sequences"
  ]).pipe(
    Effect.catchTags({
      PlatformError: (error) => Effect.fail(unavailable(error)),
      CommandFailed: (error) => Effect.fail(new GhReadFailed({ command: "api job logs", detail: error.stderr }))
    })
  )
  return log.length <= logTailBytes ? log : log.slice(-logTailBytes)
})
