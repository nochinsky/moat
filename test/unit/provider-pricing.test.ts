import assert from "node:assert/strict"
import { test } from "node:test"

import { parseCatalog } from "../../lib/catalog.ts"
import { catalogPriceForFacts } from "../../lib/model-facts.ts"
import { computeCost, usageOf } from "../../lib/pricing.ts"

/**
 * Cost reporting for a provider that is not DeepSeek.
 *
 * `lib/pricing.ts` holds a hand-checked table because models.dev's DeepSeek prices are wrong — that
 * is why the table exists at all. For every other provider there is no table, so before this the
 * footer reported *nothing*: `known: false`, no money, and a run against OpenRouter silently
 * showed no cost while a DeepSeek one showed a figure. The catalog moat already fetches carries a
 * price per model, so it is used for those and DeepSeek stays on the table.
 */

const RAW = {
  openrouter: {
    name: "OpenRouter",
    api: "https://openrouter.ai/api/v1",
    env: ["OPENROUTER_API_KEY"],
    models: {
      "vendor/model-x": {
        name: "Model X",
        tool_call: true,
        limit: { context: 200000, output: 8192 },
        cost: { input: 3, output: 15, cache_read: 0.3 },
      },
      "vendor/no-price": { name: "No Price", tool_call: true },
      "vendor/bad-price": { name: "Bad Price", tool_call: true, cost: { input: "free", output: 15 } },
      "vendor/negative": { name: "Negative", tool_call: true, cost: { input: -1, output: 15 } },
    },
  },
  deepseek: {
    name: "DeepSeek",
    env: ["DEEPSEEK_API_KEY"],
    models: { "deepseek-flash": { name: "DeepSeek V4.1 Flash", cost: { input: 0.1, output: 0.2 } } },
  },
}

const catalog = parseCatalog(RAW as never)
const facts = (providerID: string, id: string) =>
  ({ providerID, id }) as Parameters<typeof catalogPriceForFacts>[0]

test("a non-DeepSeek model is priced from the catalog", () => {
  const price = catalogPriceForFacts(facts("openrouter", "vendor/model-x"), catalog)
  assert.deepEqual(price, { input: 3, output: 15, cacheRead: 0.3 })

  // 1M input, 1M output: 3 + 15. The arithmetic is `computeCost`'s, and this is the case the
  // footer could not reach before.
  const usage = usageOf({ input: 1_000_000, output: 1_000_000 })
  const cost = computeCost("vendor/model-x", usage, new Date("2026-01-01T00:00:00Z"), price)
  assert.equal(cost.known, true, "a catalog-priced model reported its cost as unknown")
  assert.equal(cost.usd, 18)
  assert.equal(cost.peak, false, "a catalog-priced turn must not claim DeepSeek's peak pricing")
})

test("DeepSeek is never priced from the catalog", () => {
  // The whole reason `lib/pricing.ts` exists is that models.dev's DeepSeek prices are wrong. If the
  // catalog ever won here, the footer would silently report the wrong number rather than none.
  assert.equal(catalogPriceForFacts(facts("deepseek", "deepseek-flash"), catalog), undefined)
})

test("a model with no usable price reports unknown rather than zero", () => {
  for (const id of ["vendor/no-price", "vendor/bad-price", "vendor/negative", "vendor/absent"]) {
    assert.equal(catalogPriceForFacts(facts("openrouter", id), catalog), undefined, `${id} produced a price`)
    const cost = computeCost(id, usageOf({ input: 1000, output: 1000 }))
    assert.equal(cost.known, false, `${id} reported a known cost with no price`)
    assert.equal(cost.usd, 0)
  }
})

test("a cached turn with no published cache price is charged at the input rate", () => {
  // Not zero. Treating an unpublished cache-read price as free would understate a mostly-cached
  // turn, and an understated figure is the failure this module was written to prevent.
  const bare = parseCatalog({
    p: { name: "P", models: { m: { cost: { input: 2, output: 10 } } } },
  } as never)
  const price = catalogPriceForFacts(facts("p", "m"), bare)
  assert.deepEqual(price, { input: 2, output: 10 })

  const cost = computeCost("m", usageOf({ input: 1_000_000, cache: { read: 1_000_000 } }), new Date(), price)
  assert.equal(cost.usd, 4, "a 1M cached read at an unpublished rate should cost the input rate")
})
