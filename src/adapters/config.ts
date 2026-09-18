import type { Config, Types } from "effect"
import { Context, Effect, FileSystem, Layer, Option, Path, PlatformError, Predicate, Schema } from "effect"
import { Yaml } from "effect/unstable/encoding"
import { KeyValueStore } from "effect/unstable/persistence"

import { xdgDirectory } from "#adapters/xdg.ts"
import type { Value } from "#adapters/yaml.ts"
import { encodeYaml } from "#adapters/yaml.ts"
import { Effort, Severity } from "#terms/review.ts"

/**
 * What one section of the file may say. Every key is optional: what the file
 * leaves out is inherited rather than reset, so `defaults` and a repository's
 * overrides are the same shape.
 */
const SettingsPatch = Schema.Struct({
  base: Schema.optionalKey(Schema.NullOr(Schema.String)),
  review: Schema.optionalKey(
    Schema.Struct({
      command: Schema.optionalKey(Schema.NullOr(Schema.String)),
      effort: Schema.optionalKey(Schema.NullOr(Effort)),
      prompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
      model: Schema.optionalKey(Schema.NullOr(Schema.String)),
      docs_only: Schema.optionalKey(Schema.Array(Schema.String))
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
      blocks_on: Schema.optionalKey(Severity)
    })
  )
})
export type SettingsPatch = typeof SettingsPatch.Type

/** How this machine starts Claude Code, where it does not start `claude` itself. */
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
  fix_args: Schema.optionalKey(Schema.Array(Schema.String))
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
    command: "/code-review",
    effort: "low",
    prompt: null,
    model: null,
    docs_only: ["**/*.md", "docs/**"]
  },
  ci: { ignore: [], flaky_patterns: [] },
  fix: { commits: false },
  rebase: { enabled: false },
  stamp: { blocks_on: "error" }
}

/** What this machine spawns Claude Code with, once the file has been read. */
export interface Launcher {
  /** The program, then the arguments it takes before mission control's own. */
  readonly command: readonly [string, ...Array<string>]
  /** The flags only a fix session gets, the one run that is no review run. */
  readonly fix_args: ReadonlyArray<string>
}

/** `claude` itself, which is what a machine that spawns it directly needs. */
export const builtInLauncher: Launcher = { command: ["claude"], fix_args: [] }

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
          command: over(patch.review?.command, settings.review.command),
          effort: over(patch.review?.effort, settings.review.effort),
          prompt: over(patch.review?.prompt, settings.review.prompt),
          model: over(patch.review?.model, settings.review.model),
          docs_only: over(patch.review?.docs_only, settings.review.docs_only)
        },
        ci: {
          ignore: over(patch.ci?.ignore, settings.ci.ignore),
          flaky_patterns: over(patch.ci?.flaky_patterns, settings.ci.flaky_patterns)
        },
        fix: { commits: over(patch.fix?.commits, settings.fix.commits) },
        rebase: { enabled: over(patch.rebase?.enabled, settings.rebase.enabled) },
        stamp: { blocks_on: over(patch.stamp?.blocks_on, settings.stamp.blocks_on) }
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
 * What this machine starts Claude Code with: the file's launcher over `claude`.
 *
 * It is no repository's business. What spawns the agent CLI is a fact of the
 * machine, which is why it sits beside `defaults` rather than inside it.
 */
export const launcherOf = (file: ConfigFile): Launcher => {
  const [program = builtInLauncher.command[0], ...prefix] = file.launcher?.command ?? []
  return {
    command: [program, ...prefix],
    fix_args: file.launcher?.fix_args ?? builtInLauncher.fix_args
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

const reasonOf = (cause: unknown): string => (Predicate.isError(cause) ? cause.message : String(cause))

/** The keys an earlier version had, read off a file loosely enough to find them. */
const LegacySection = Schema.Struct({
  review: Schema.optionalKey(
    Schema.Struct({
      runners: Schema.optionalKey(Schema.Unknown),
      skill: Schema.optionalKey(Schema.Unknown),
      path_instructions: Schema.optionalKey(Schema.Unknown)
    })
  ),
  stamp: Schema.optionalKey(Schema.Struct({ supporting_blocks: Schema.optionalKey(Schema.Unknown) }))
})

const Legacy = Schema.Struct({
  launcher: Schema.optionalKey(Schema.Struct({ codex: Schema.optionalKey(Schema.Unknown) })),
  defaults: Schema.optionalKey(LegacySection),
  repos: Schema.optionalKey(Schema.Record(Schema.String, LegacySection))
})

const asLegacy = Schema.decodeUnknownOption(Legacy)

/**
 * What a file from an earlier version says, and what to do about each of it.
 *
 * The excess-property error names a key and stops there, which is enough for a
 * key that is simply gone and not enough for one that moved: `review.skill` is
 * `review.prompt` now, and a file quietly stripped of it is a review brief lost.
 * This is here to be deleted once no file has those keys left.
 */
const legacyIn = (decided: unknown): string | null => {
  const legacy = asLegacy(decided)
  if (Option.isNone(legacy)) {
    return null
  }
  const sections = [legacy.value.defaults, ...Object.values(legacy.value.repos ?? {})]
  const spelled = (says: (section: typeof LegacySection.Type) => unknown): boolean =>
    sections.some((section) => section !== undefined && says(section) !== undefined)

  const said = [
    legacy.value.launcher?.codex === undefined ? null : "launcher.codex is gone: reviews run on Claude Code alone.",
    spelled((section) => section.review?.runners)
      ? "review.runners is gone: a head carries one review run, which review.command configures."
      : null,
    spelled((section) => section.review?.skill)
      ? "review.skill is review.prompt now, unchanged in what it does - move the text across rather than losing it."
      : null,
    spelled((section) => section.review?.path_instructions)
      ? "review.path_instructions is gone: nothing ever read it."
      : null,
    spelled((section) => section.stamp?.supporting_blocks)
      ? "stamp.supporting_blocks is gone: there is no second opinion to let through."
      : null
  ].filter((sentence) => sentence !== null)

  return said.length === 0 ? null : `it names keys this version does not have.\n${said.join("\n")}`
}

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

  const legacy = legacyIn(decided)
  if (legacy !== null) {
    return yield* malformed(legacy)
  }

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
            ["command", patch.review.command],
            ["effort", patch.review.effort],
            ["prompt", patch.review.prompt],
            ["model", patch.review.model],
            ["docs_only", patch.review.docs_only]
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
    ["stamp", patch.stamp === undefined ? undefined : mapping([["blocks_on", patch.stamp.blocks_on]])]
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
            ["fix_args", file.launcher.fix_args]
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
