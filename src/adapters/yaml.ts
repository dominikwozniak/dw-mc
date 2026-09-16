import { Predicate } from "effect"

/** A value this writer can put on paper: what `Yaml.parse` gives back. */
export type Value = null | boolean | number | string | ReadonlyArray<Value> | { readonly [key: string]: Value }

/**
 * A word YAML reads as itself. Anything else - a glob, an empty string, a
 * branch with a space - is quoted, and the JSON escapes are a subset of the
 * YAML double-quoted ones, so `JSON.stringify` is the quoting.
 */
const word = /^[A-Za-z][\w./-]*$/

/** Words the YAML 1.2 core schema reads as something other than a string. */
const reserved = new Set(["true", "false", "null", "yes", "no", "on", "off", "y", "n"])

const scalar = (value: null | boolean | number | string): string => {
  if (value === null) {
    return "null"
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false"
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return ".nan"
    }
    if (!Number.isFinite(value)) {
      return value > 0 ? ".inf" : "-.inf"
    }
    return String(value)
  }
  return word.test(value) && !reserved.has(value.toLowerCase()) ? value : JSON.stringify(value)
}

const isMapping = (value: Value): value is { readonly [key: string]: Value } => Predicate.isObject(value)

/** `Array.isArray` widens to `any[]`, which leaves the union unnarrowed. */
const isSequence = (value: Value): value is ReadonlyArray<Value> => Array.isArray(value)

const pad = (depth: number): string => "  ".repeat(depth)

/**
 * Writes one entry, where `prefix` is everything up to the value: a mapping's
 * `key:` or a sequence's `-`. `depth` is where this entry's children go, which
 * a sequence item sets one deeper than the dash it hangs from.
 */
const writeEntry = (prefix: string, value: Value, depth: number, out: Array<string>): void => {
  if (isSequence(value)) {
    if (value.length === 0) {
      out.push(`${prefix} []`)
      return
    }
    out.push(prefix)
    writeSequence(value, depth, out)
    return
  }
  if (isMapping(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) {
      out.push(`${prefix} {}`)
      return
    }
    out.push(prefix)
    writeMapping(entries, depth, out)
    return
  }
  out.push(`${prefix} ${scalar(value)}`)
}

const writeMapping = (entries: ReadonlyArray<readonly [string, Value]>, depth: number, out: Array<string>): void => {
  for (const [key, value] of entries) {
    writeEntry(`${pad(depth)}${scalar(key)}:`, value, depth + 1, out)
  }
}

const writeSequence = (items: ReadonlyArray<Value>, depth: number, out: Array<string>): void => {
  for (const item of items) {
    const entries = isMapping(item) ? Object.entries(item) : []
    const [first, ...rest] = entries
    if (first === undefined) {
      writeEntry(`${pad(depth)}-`, item, depth + 1, out)
      continue
    }
    writeEntry(`${pad(depth)}- ${scalar(first[0])}:`, first[1], depth + 2, out)
    writeMapping(rest, depth + 1, out)
  }
}

/**
 * Writes one YAML document, in the order the keys were built in.
 *
 * Effect parses YAML but does not write it, and the configuration file is one
 * the tool rewrites on every `init`. Collections are written as blocks, so the
 * file stays diffable and editable by hand.
 */
export const encodeYaml = (value: Value): string => {
  const out: Array<string> = []
  if (isSequence(value)) {
    if (value.length === 0) {
      return "[]\n"
    }
    writeSequence(value, 0, out)
  } else if (isMapping(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) {
      return "{}\n"
    }
    writeMapping(entries, 0, out)
  } else {
    out.push(scalar(value))
  }
  return `${out.join("\n")}\n`
}
