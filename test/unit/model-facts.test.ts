import assert from "node:assert/strict"
import { test } from "node:test"
import { renderPiFiles } from "../../bundle/pi.ts"
import { catalogPriceForFacts, checkEffort, describeModelFacts, resolveModelFacts } from "../../lib/model-facts.ts"
import type { Catalog } from "../../lib/catalog.ts"
import { computeCost } from "../../lib/pricing.ts"

const catalog: Catalog = new Map([["acme", {
  id: "acme", name: "Acme", envVars: [], models: [{ id: "model", name: "Acme Model", toolCall: true, reasoning: true, context: 128_000, output: 16_000, attachment: true, cost: { input: 1, output: 2, cacheRead: 0.1 } }],
}]])
function entry(facts: ReturnType<typeof resolveModelFacts>) {
  return JSON.parse(renderPiFiles({ facts, providerID: facts.providerID, baseURL: "https://acme.example" }).catalog).providers[facts.providerID].models[0]
}
test("the catalog, Pi and reports use the same name, limits, capabilities and ladder", () => {
  const facts = resolveModelFacts({ catalog, providerID: "acme", modelID: "model", providerIsNative: true, effortLevels: ["none", "medium", "high"], defaultEffort: "medium" })
  assert.equal(facts.displayName, "Acme Model")
  const model = entry(facts)
  assert.equal(model.id, facts.id)
  assert.equal(model.name, facts.displayName)
  assert.equal(model.contextWindow, facts.contextWindow)
  assert.equal(model.maxTokens, facts.maxOutputTokens)
  assert.deepEqual(model.input, ["text", "image"])
  assert.equal(model.thinkingLevelMap.medium, "medium")
  assert.equal(model.thinkingLevelMap.max, null)
  assert.match(describeModelFacts(facts), /acme\/model.*128k/)
  assert.equal(checkEffort("medium", facts.effortLevels), null)
  assert.match(checkEffort("max", facts.effortLevels)!, /unknown --effort/)
  assert.deepEqual(catalogPriceForFacts(facts, catalog), { input: 1, output: 2, cacheRead: 0.1 })
})
test("unknown models retain their provider/id, but invented limits and prices do not reach Pi", () => {
  for (const data of [catalog, null]) {
    const facts = resolveModelFacts({ catalog: data, providerID: "moat", modelID: "org/unknown", providerIsNative: false })
    const model = entry(facts)
    assert.equal(model.name, "org/unknown")
    assert.equal(model.contextWindow, undefined)
    assert.equal(model.maxTokens, undefined)
    assert.equal(facts.label, "moat/org/unknown")
    assert.equal(catalogPriceForFacts(facts, data), undefined)
  }
})
test("an identically named model at another provider cannot borrow DeepSeek's price", () => {
  const usage = { input: 100, output: 10, cacheRead: 0, reasoning: 0 }
  const native = resolveModelFacts({ catalog: null, providerID: "deepseek", modelID: "deepseek-flash", providerIsNative: true })
  const other = resolveModelFacts({ catalog: null, providerID: "acme", modelID: "deepseek-flash", providerIsNative: false })
  assert.equal(computeCost(native.pricingID, usage).known, true)
  assert.equal(computeCost(other.pricingID, usage).known, false)
})
test("a non-reasoning model does not default to unsupported thinking", () => {
  const nonReasoning: Catalog = new Map([["acme", { id: "acme", name: "Acme", envVars: [], models: [{ id: "plain", toolCall: true, reasoning: false }] }]])
  const facts = resolveModelFacts({ catalog: nonReasoning, providerID: "acme", modelID: "plain", providerIsNative: true })
  assert.equal(facts.defaultEffort, "none")
  assert.deepEqual(facts.effortLevels, ["none"])
  assert.equal(entry(facts).reasoning, false)
})
