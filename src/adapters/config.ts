import type { Config, Types } from "effect"
import { Context, Effect, FileSystem, Layer, Option, Path, PlatformError, Schema } from "effect"
import { Yaml } from "effect/unstable/encoding"
import { KeyValueStore } from "effect/unstable/persistence"

import { xdgDirectory } from "#adapters/xdg.ts"
import type { Value } from "#adapters/yaml.ts"
import { encodeYaml } from "#adapters/yaml.ts"

/**
 * What a review run executes: the agent's own review command, or the tool's own
 * review prompt on one of the two agent CLIs.
 *
 * `builtin` and `prompt` run on the launcher, which is Claude Code. `codex`
 * runs the same prompt on the Codex CLI, and is the second opinion: configured
 * beside one of the others, its findings inform me without gating my bar.
 */
export const runners = ["builtin", "prompt", "codex"] as const
export const Runner = Schema.Literals(runners)
export type Runner = typeof Runner.Type

/** How much a built-in review run spends. */
export const Effort = Schema.Literals(["low", "medium", "high"])
export type Effort = typeof Effort.Type

/** How much a finding weighs. */
export const Severity = Schema.Literals(["error", "warning", "info"])
export type Severity = typeof Severity.Type

const PathInstruction = Schema.Struct({
  path: Schema.String,
  instructions: Schema.String
})

/**
 * What one section of the file may say. Every key is optional: what the file
 * leaves out is inherited rather than reset, so `defaults` and a repository's
 * overrides are the same shape.
 */
const SettingsPatch = Schema.Struct({
  base: Schema.optionalKey(Schema.NullOr(Schema.String)),
  review: Schema.optionalKey(
    Schema.Struct({
      runners: Schema.optionalKey(Schema.Array(Runner)),
      effort: Schema.optionalKey(Effort),
      model: Schema.optionalKey(Schema.NullOr(Schema.String)),
      skill: Schema.optionalKey(Schema.NullOr(Schema.String)),
      docs_only: Schema.optionalKey(Schema.Array(Schema.String)),
      path_instructions: Schema.optionalKey(Schema.Array(PathInstruction))
    })
  ),
  ci: Schema.optionalKey(
    Schema.Struct({
      ignore: Schema.optionalKey(Schema.Array(Schema.String)),
      flaky_patterns: Schema.optionalKey(Schema.Array(Schema.String))
    })
  ),
  fix: Schema.optionalKey(
    Schema.Struct({
      commits: Schema.optionalKey(Schema.Boolean)
    })
  ),
  rebase: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean)
    })
  ),
  stamp: Schema.optionalKey(
    Schema.Struct({
      blocks_on: Schema.optionalKey(Severity),
      supporting_blocks: Schema.optionalKey(Schema.Boolean)
    })
  )
})
export type SettingsPatch = typeof SettingsPatch.Type

/** How this machine starts a runner, where it does not start `claude` itself. */
const LauncherPatch = Schema.Struct({
  // An argv list and never a shell string: a shell string needs `sh -c` in
  // front of it, and that extra process sits in the terminal's foreground
  // group, where it takes the inherited standard input and the Ctrl-C of a fix
  // session with it.
  command: Schema.optionalKey(
    Schema.Array(Schema.String).pipe(
      Schema.check(Schema.isMinLength(1, { message: "Expected the launcher command to name a program" }))
    )
  ),
  fix_args: Schema.optionalKey(Schema.Array(Schema.String)),
  // The second agent CLI, named the same way and for the same reason: which
  // program reaches Codex is a fact of this machine. It sits beside `command`
  // rather than replacing it, because a machine that asks Codex for a second
  // opinion is a machine that has both CLIs.
  codex: Schema.optionalKey(
    Schema.Array(Schema.String).pipe(
      Schema.check(Schema.isMinLength(1, { message: "Expected the codex command to name a program" }))
    )
  )
})

/** A repository, as `gh` spells it: `owner/name`. */
export const Repo = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^\s/]+\/[^\s/]+$/, { message: "Expected a repository as owner/name" }))
)

/** The whole configuration file: global defaults and per-repository overrides. */
export const ConfigFile = Schema.Struct({
  launcher: Schema.optionalKey(LauncherPatch),
  defaults: Schema.optionalKey(SettingsPatch),
  repos: Schema.optionalKey(Schema.Record(Repo, SettingsPatch))
})
export type ConfigFile = typeof ConfigFile.Type

type Section<K extends keyof SettingsPatch> = Required<NonNullable<SettingsPatch[K]>>

/** What one repository's settings come to once the file has been resolved. */
export interface Settings {
  readonly base: string | null
  readonly review: Section<"review">
  readonly ci: Section<"ci">
  readonly fix: Section<"fix">
  readonly rebase: Section<"rebase">
  readonly stamp: Section<"stamp">
}

/** What every setting is worth before the file says anything. */
export const builtIn: Settings = {
  base: null,
  review: {
    runners: ["builtin"],
    effort: "low",
    model: null,
    skill: null,
    docs_only: ["**/*.md", "docs/**"],
    path_instructions: []
  },
  ci: { ignore: [], flaky_patterns: [] },
  fix: { commits: false },
  rebase: { enabled: false },
  stamp: { blocks_on: "error", supporting_blocks: false }
}

/** What this machine spawns a runner with, once the file has been read. */
export interface Launcher {
  /** The program, then the arguments it takes before mission control's own. */
  readonly command: readonly [string, ...Array<string>]
  /** The flags only a fix session gets, the one run that is no review run. */
  readonly fix_args: ReadonlyArray<string>
  /** The program, then its prefix, that reaches the Codex CLI. */
  readonly codex: readonly [string, ...Array<string>]
}

/** `claude` and `codex` themselves, which is what a machine that spawns them directly needs. */
export const builtInLauncher: Launcher = { command: ["claude"], fix_args: [], codex: ["codex"] }

/**
 * The patch's value where it has one, the inherited value otherwise. A key the
 * file spells out counts even when it says `null`, which is how a repository
 * resets a global default.
 */
const over = <A>(patch: A | undefined, inherited: A): A => (patch === undefined ? inherited : patch)

const apply = (settings: Settings, patch: SettingsPatch | undefined): Settings =>
  patch === undefined
    ? settings
    : {
        base: over(patch.base, settings.base),
        review: {
          runners: over(patch.review?.runners, settings.review.runners),
          effort: over(patch.review?.effort, settings.review.effort),
          model: over(patch.review?.model, settings.review.model),
          skill: over(patch.review?.skill, settings.review.skill),
          docs_only: over(patch.review?.docs_only, settings.review.docs_only),
          path_instructions: over(patch.review?.path_instructions, settings.review.path_instructions)
        },
        ci: {
          ignore: over(patch.ci?.ignore, settings.ci.ignore),
          flaky_patterns: over(patch.ci?.flaky_patterns, settings.ci.flaky_patterns)
        },
        fix: { commits: over(patch.fix?.commits, settings.fix.commits) },
        rebase: { enabled: over(patch.rebase?.enabled, settings.rebase.enabled) },
        stamp: {
          blocks_on: over(patch.stamp?.blocks_on, settings.stamp.blocks_on),
          supporting_blocks: over(patch.stamp?.supporting_blocks, settings.stamp.supporting_blocks)
        }
      }

/**
 * `delta` over `patch`, keeping every key `delta` does not mention.
 *
 * Sections merge key by key rather than being replaced, which is what lets a
 * second `init` change one of a repository's settings and lose none of the rest.
 */
export const merge = (patch: SettingsPatch, delta: SettingsPatch): SettingsPatch => {
  const merged: Types.Mutable<SettingsPatch> = { ...patch, ...delta }
  if (patch.review !== undefined && delta.review !== undefined) {
    merged.review = { ...patch.review, ...delta.review }
  }
  if (patch.ci !== undefined && delta.ci !== undefined) {
    merged.ci = { ...patch.ci, ...delta.ci }
  }
  if (patch.fix !== undefined && delta.fix !== undefined) {
    merged.fix = { ...patch.fix, ...delta.fix }
  }
  if (patch.rebase !== undefined && delta.rebase !== undefined) {
    merged.rebase = { ...patch.rebase, ...delta.rebase }
  }
  if (patch.stamp !== undefined && delta.stamp !== undefined) {
    merged.stamp = { ...patch.stamp, ...delta.stamp }
  }
  return merged
}

/** Whether a patch decides anything at all. */
const decidesNothing = (patch: SettingsPatch): boolean => Object.keys(patch).length === 0

/**
 * `file` with `defaults` as its global defaults, and with the section left out
 * where those defaults decide nothing, so an empty `defaults:` is never written.
 */
export const withDefaults = (file: ConfigFile, defaults: SettingsPatch): ConfigFile =>
  decidesNothing(defaults) ? file : { ...file, defaults }

/** `file` with `patch` over `repo`'s settings, registering `repo` when it is new. */
export const withRepo = (file: ConfigFile, repo: string, patch: SettingsPatch): ConfigFile => ({
  ...file,
  repos: { ...file.repos, [repo]: merge(file.repos?.[repo] ?? {}, patch) }
})

/**
 * What this machine starts a runner with: the file's launcher over `claude`.
 *
 * It is no repository's business. What spawns the agent CLI is a fact of the
 * machine, which is why it sits beside `defaults` rather than inside it.
 */
export const launcherOf = (file: ConfigFile): Launcher => {
  const [program = builtInLauncher.command[0], ...prefix] = file.launcher?.command ?? []
  const [codex = builtInLauncher.codex[0], ...codexPrefix] = file.launcher?.codex ?? []
  return {
    command: [program, ...prefix],
    fix_args: file.launcher?.fix_args ?? builtInLauncher.fix_args,
    codex: [codex, ...codexPrefix]
  }
}

/** What `repo` is worth: its own overrides over the global defaults. */
export const settingsFor = (file: ConfigFile, repo: string): Settings =>
  apply(apply(builtIn, file.defaults), file.repos?.[repo])

/**
 * Where the configuration lives: `$XDG_CONFIG_HOME/dw-mc`, or
 * `$HOME/.config/dw-mc` when XDG says nothing.
 */
export const configDirectory: Effect.Effect<string, Config.ConfigError, Path.Path> = xdgDirectory(
  "XDG_CONFIG_HOME",
  ".config"
)

const fileName = "config.yaml"

/** The one file, in the one place, that I can read, edit and keep in my dotfiles. */
export const configPath: Effect.Effect<string, Config.ConfigError, Path.Path> = Effect.gen(function* () {
  const path = yield* Path.Path
  const directory = yield* configDirectory
  return path.join(directory, fileName)
}).pipe(Effect.withSpan("config.configPath"))

const service = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore
  const path = yield* configPath
  return { path, store }
})

const onDisk = Layer.unwrap(Effect.map(configDirectory, (directory) => KeyValueStore.layerFileSystem(directory)))

/**
 * The configuration file, behind the key/value seam.
 *
 * A file store over the configuration directory writes `config.yaml` at exactly
 * the path the design promises, so the seam costs the file nothing. Its store is
 * built fresh, so it is never the one the state directory is using.
 */
export class ConfigStore extends Context.Service<
  ConfigStore,
  {
    readonly path: string
    readonly store: KeyValueStore.KeyValueStore
  }
>()("dw-mc/config/ConfigStore") {
  /** The configuration file on disk. */
  static readonly layer: Layer.Layer<
    ConfigStore,
    Config.ConfigError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > = Layer.effect(ConfigStore, service).pipe(Layer.provide(Layer.fresh(onDisk)))

  /** A configuration file that lives only as long as the test that builds it. */
  static readonly layerTest: Layer.Layer<ConfigStore, Config.ConfigError, Path.Path> = Layer.effect(
    ConfigStore,
    service
  ).pipe(Layer.provide(Layer.fresh(KeyValueStore.layerMemory)))
}

/** A configuration file that is there but is not configuration. */
export class ConfigMalformed extends Schema.TaggedError<ConfigMalformed>()("ConfigMalformed", {
  path: Schema.String,
  reason: Schema.String
}) {
  override get message(): string {
    return (
      `${this.path} is not valid dw-mc configuration: ${this.reason}\n` +
      `Fix the file, or delete it and run 'dw-mc init' again.`
    )
  }
}

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * The configuration file, or `None` when this machine has none yet.
 *
 * A file that is there and is wrong stops the caller: an unreadable key, a
 * value of the wrong type and a misspelled key all fail here rather than
 * turning into a default that quietly means something else.
 */
export const read = Effect.gen(function* () {
  const config = yield* ConfigStore
  const raw = yield* config.store.get(fileName)
  if (raw === undefined) {
    return Option.none<ConfigFile>()
  }

  const malformed = (reason: string) => new ConfigMalformed({ path: config.path, reason })
  const parsed = yield* Effect.try({
    try: () => Yaml.parse(raw),
    catch: (cause) => malformed(reasonOf(cause))
  })
  // An empty document parses to null: the file is there and decides nothing.
  const decided: unknown = parsed ?? {}

  return Option.some(
    yield* Schema.decodeUnknownEffect(ConfigFile)(decided, {
      onExcessProperty: "error",
      errors: "all"
    }).pipe(Effect.mapError((error) => malformed(error.message)))
  )
}).pipe(Effect.withSpan("config.read"))

const mapping = (entries: ReadonlyArray<readonly [string, Value | undefined]>): { readonly [key: string]: Value } => {
  const out: Record<string, Value> = {}
  for (const [key, value] of entries) {
    if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

const settingsDocument = (patch: SettingsPatch): Value =>
  mapping([
    ["base", patch.base],
    [
      "review",
      patch.review === undefined
        ? undefined
        : mapping([
            ["runners", patch.review.runners],
            ["effort", patch.review.effort],
            ["model", patch.review.model],
            ["skill", patch.review.skill],
            ["docs_only", patch.review.docs_only],
            ["path_instructions", patch.review.path_instructions]
          ])
    ],
    [
      "ci",
      patch.ci === undefined
        ? undefined
        : mapping([
            ["ignore", patch.ci.ignore],
            ["flaky_patterns", patch.ci.flaky_patterns]
          ])
    ],
    ["fix", patch.fix === undefined ? undefined : mapping([["commits", patch.fix.commits]])],
    ["rebase", patch.rebase === undefined ? undefined : mapping([["enabled", patch.rebase.enabled]])],
    [
      "stamp",
      patch.stamp === undefined
        ? undefined
        : mapping([
            ["blocks_on", patch.stamp.blocks_on],
            ["supporting_blocks", patch.stamp.supporting_blocks]
          ])
    ]
  ])

/**
 * The file as a YAML document, in the order of the schema.
 *
 * Writing the keys in a fixed order rather than the order they were built in
 * keeps the file stable across runs, so a rewrite shows only what changed.
 */
const fileDocument = (file: ConfigFile): Value =>
  mapping([
    [
      "launcher",
      file.launcher === undefined
        ? undefined
        : mapping([
            ["command", file.launcher.command],
            ["fix_args", file.launcher.fix_args],
            ["codex", file.launcher.codex]
          ])
    ],
    ["defaults", file.defaults === undefined ? undefined : settingsDocument(file.defaults)],
    [
      "repos",
      file.repos === undefined
        ? undefined
        : mapping(Object.entries(file.repos).map(([name, patch]) => [name, settingsDocument(patch)] as const))
    ]
  ])

const header = "# dw-mc configuration. 'dw-mc init' rewrites this file and keeps no comments."

/**
 * The file as it would be written.
 *
 * Exposed so a caller can tell whether writing would decide anything
 * differently, and leave the file alone when it would not.
 */
export const encode = (file: ConfigFile): string => `${header}\n${encodeYaml(fileDocument(file))}`

/** Writes the whole file, replacing what was there. */
export const write = Effect.fn("config.write")(function* (file: ConfigFile) {
  const config = yield* ConfigStore
  yield* config.store.set(fileName, encode(file))
})
