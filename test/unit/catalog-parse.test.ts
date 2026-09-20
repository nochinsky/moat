import assert from "node:assert/strict"
import { test } from "node:test"

import { formatTokens, parseCatalog } from "../../lib/catalog.ts"

test("a catalog's token limits are validated, not cast", () => {
  // `models.dev` is a fetched JSON document, and `parseCatalog` used to read its numbers with a
  // bare cast: `limit.context` reached the Codex config renderer as whatever JSON can hold. That
  // is how a string, a float or 1e999 became an unquoted TOML number Codex refuses to parse.
  // A count has to be a positive safe integer to mean anything; anything else is "unknown", and
  // the renderer already knows how to leave an unknown out.
  const catalog = parseCatalog({
    deepseek: {
      name: "DeepSeek",
      env: ["DEEPSEEK_API_KEY"],
      api: "https://api.deepseek.com",
      models: {
        good: { limit: { context: 131072, output: 32768 } },
        nan: { limit: { context: Number.NaN, output: Number.NaN } },
        infinity: { limit: { context: Number.POSITIVE_INFINITY, output: 1e999 } },
        negative: { limit: { context: -1, output: -131072 } },
        zero: { limit: { context: 0, output: 0 } },
        float: { limit: { context: 131072.5, output: 1.5 } },
        string: { limit: { context: "131072" as unknown as number, output: "32768" as unknown as number } },
        nullish: { limit: { context: null as unknown as number, output: undefined } },
        object: { limit: { context: {} as unknown as number, output: [] as unknown as number } },
        unsafe: { limit: { context: Number.MAX_VALUE, output: 2 ** 53 } },
        absent: {},
        unlisted: { name: "no limits key" },
      },
    },
  })

  const models = new Map(catalog.get("deepseek")!.models.map((model) => [model.id, model]))
  assert.deepEqual(
    [models.get("good")!.context, models.get("good")!.output],
    [131072, 32768],
    "honest counts survive",
  )
  for (const id of [
    "nan", "infinity", "negative", "zero", "float", "string",
    "nullish", "object", "unsafe", "absent", "unlisted",
  ]) {
    assert.equal(models.get(id)!.context, undefined, `${id}.context should be unknown`)
    assert.equal(models.get(id)!.output, undefined, `${id}.output should be unknown`)
  }
  // The rest of the entry is still parsed: an unusable limit must not drop the model.
  assert.equal(models.size, 12)
  assert.deepEqual(catalog.get("deepseek")!.envVars, ["DEEPSEEK_API_KEY"])
})

test("a provider with no models object is skipped rather than half-read", () => {
  const catalog = parseCatalog({
    empty: {},
    nullish: null as never,
    real: { models: { m: { limit: { context: 1000 } } } },
  })
  assert.deepEqual([...catalog.keys()], ["real"])
  assert.equal(catalog.get("real")!.name, "real", "a provider with no name falls back to its id")
  assert.equal(catalog.get("real")!.models[0]!.toolCall, true, "tool calls default to supported")
})

test("formatTokens says '?' for an unknown count rather than printing 0", () => {
  // The display half of the same rule: `undefined` and `0` both used to print `0`, which reads
  // like a measured zero-length context window.
  assert.equal(formatTokens(undefined), "?")
  assert.equal(formatTokens(0), "?")
  assert.equal(formatTokens(131072), "131k")
  assert.equal(formatTokens(1_000_000), "1M")
  assert.equal(formatTokens(1_500_000), "1.5M")
  assert.equal(formatTokens(512), "512")
})
