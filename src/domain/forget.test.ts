import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"

import * as Store from "#adapters/store.ts"
import { forget, isAbout } from "#domain/forget.ts"

const repo = "dominikwozniak/dw-mc"
const head = "284d599022a55d4dcae74b31b9a49a0f50061014"
const earlier = "9f2b0c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192"

describe("isAbout", () => {
  it("claims the pull request's key in any namespace", () => {
    for (const namespace of ["prs", "stamps", "reruns", "rebases", "acknowledgements", "watermarks", "not-yet-named"]) {
      assert.isTrue(isAbout(`${namespace}/${repo}#28`, repo, 28))
    }
  })

  it("claims a review run, its report and the index of the last one, at any head", () => {
    assert.isTrue(isAbout(`runs/${repo}#28@${head}`, repo, 28))
    assert.isTrue(isAbout(`runs/${repo}#28@${earlier}.md`, repo, 28))
    assert.isTrue(isAbout(`runs/${repo}#28@latest`, repo, 28))
  })

  it("leaves a pull request whose number only starts the same", () => {
    assert.isFalse(isAbout(`prs/${repo}#280`, repo, 28))
    assert.isFalse(isAbout(`runs/${repo}#280@${head}`, repo, 28))
    assert.isFalse(isAbout(`prs/${repo}#2`, repo, 28))
  })

  it("leaves the same number in another repository", () => {
    assert.isFalse(isAbout(`prs/${repo}-app#28`, repo, 28))
    assert.isFalse(isAbout(`prs/other/dw-mc#28`, repo, 28))
  })

  it("leaves a key with no namespace at all", () => {
    assert.isFalse(isAbout(`${repo}#28`, repo, 28))
  })
})

describe("forget", () => {
  it.effect("removes every key of the pull request and nothing beside it", () =>
    Effect.gen(function* () {
      const raw = yield* KeyValueStore.KeyValueStore
      const mine = [
        `prs/${repo}#28`,
        `runs/${repo}#28@${head}`,
        `runs/${repo}#28@${head}.md`,
        `runs/${repo}#28@${earlier}`,
        `runs/${repo}#28@${earlier}.md`,
        `runs/${repo}#28@latest`,
        `stamps/${repo}#28`,
        `reruns/${repo}#28`,
        `rebases/${repo}#28`,
        `acknowledgements/${repo}#28`,
        `watermarks/${repo}#28`
      ]
      const beside = [`prs/${repo}#280`, `runs/${repo}#29@${head}`, `prs/other/dw-mc#28`]
      yield* Effect.forEach([...mine, ...beside], (key) => raw.set(key, "{}"), { discard: true })

      assert.strictEqual(yield* forget(repo, 28), mine.length)

      assert.deepStrictEqual((yield* (yield* Store.Keys).all).toSorted(), beside.toSorted())
    }).pipe(Effect.provide(Store.layerTest))
  )

  it.effect("forgets a pull request it keeps nothing about without complaint", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* forget(repo, 28), 0)
    }).pipe(Effect.provide(Store.layerTest))
  )
})
