import assert from "node:assert/strict"
import { test } from "node:test"

import type { Catalog } from "../../lib/catalog.ts"
import {
  catalogEntryFromFacts,
  checkEffort,
  defaultEffortLevels,
  describeModelFacts,
  renderCatalogFromFacts,
  resolveModelFacts,
} from "../../lib/model-facts.ts"

/**
 * One model described twice was the defect this module exists to remove.
 *
 * `lib/catalog.ts` (models.dev, fetched) knew the default model's name was `DeepSeek V4.1 Flash`,
 * and `bundle/model-catalog.ts` (rendered per boot, handed to Codex) said its display name was
 * `deepseek-flash`, because the caller had nothing else to pass it. One boot, two names for one
 * model. These tests are about the record both readers now share, and about the branches a model
 * can arrive through: described by models.dev, named by a provider but not described, or a
 * `--base-url` model nobody has published anything about.
 */

/** A catalog shaped like models.dev's, with the fields the resolution reads. */
function catalogWith(providers: Record<string, unknown>): Catalog {
  return new Map(
    Object.entries(providers).map(([id, provider]) => [
      id,
      {
        id,
        name: id,
        envVars: [],
        models: [],
        ...(provider as Record<string, never>),
      },
    ]),
  ) as Catalog
}

const DESCRIBED = catalogWith({
  deepseek: {
    name: "DeepSeek",
    models: [
      {
        id: "deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        toolCall: true,
        reasoning: true,
        context: 1_000_000,
        output: 384_000,
      },
    ],
  },
})

test("a model models.dev describes is described by its own name, not its id", () => {
  // The bug, stated: the rendered catalog carried the raw id as `display_name` while models.dev
  // knew the human name. The record is where they agree now.
  const facts = resolveModelFacts({
    catalog: DESCRIBED,
    providerID: "deepseek",
    modelID: "deepseek-flash",
    providerIsNative: true,
  })
  assert.equal(facts.id, "deepseek-flash")
  assert.equal(facts.displayName, "DeepSeek V4.1 Flash", "models.dev's name, not the slug")
  assert.equal(facts.contextWindow, 1_000_000)
  assert.equal(facts.maxOutputTokens, 384_000)
  assert.equal(facts.native, true)
  assert.equal(facts.label, "deepseek/deepseek-flash")

  // And the catalog Codex parses is built from that same record.
  const entry = JSON.parse(renderCatalogFromFacts(facts)).models[0]
  assert.equal(entry.slug, "deepseek-flash")
  assert.equal(entry.display_name, "DeepSeek V4.1 Flash")
  assert.equal(entry.context_window, 1_000_000)
  assert.equal(entry.max_output_tokens, 384_000)
  // The ladder is moat's, matching what the facts carry, so the config and the catalog cannot
  // disagree about which levels exist.
  assert.deepEqual(
    entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort),
    facts.effortLevels,
  )
  assert.equal(entry.default_reasoning_level, facts.defaultEffort)
})

test("a model nobody describes still boots, described honestly by its id", () => {
  // The `--base-url` case, which is how the whole test suite runs: a local endpoint with a model
  // no dataset has published. Not an error — but not a silent invention either.
  const facts = resolveModelFacts({
    catalog: DESCRIBED,
    providerID: "moat",
    modelID: "mock-model",
    providerIsNative: false,
  })
  assert.equal(facts.displayName, "mock-model", "an unknown model is called what the user called it")
  assert.equal(facts.contextWindow, undefined, "and declares no limits rather than guessing")
  assert.equal(facts.maxOutputTokens, undefined)
  assert.equal(facts.native, false)
  assert.equal(facts.catalog, undefined)
  const entry = JSON.parse(renderCatalogFromFacts(facts)).models[0]
  assert.equal(entry.display_name, "mock-model")
  assert.equal("context_window" in entry, false, "no invented context window")
  // The required fields are still all there: an unknown model is still a complete entry.
  for (const field of ["slug", "display_name", "supported_reasoning_levels", "shell_type", "visibility"]) {
    assert.ok(field in entry, field)
  }
  // The log line says the model's name and no limits it does not have.
  assert.equal(describeModelFacts(facts), "model: moat/mock-model")
  assert.match(describeModelFacts(resolveModelFacts({ catalog: DESCRIBED, providerID: "deepseek", modelID: "deepseek-flash", providerIsNative: true })), /context 1M, out 384k/)
})

test("a catalog that could not be fetched resolves like an unknown model, not like a failure", () => {
  // `loadCatalog` returns null when there is no network and no cache. The boot must proceed:
  // this is the offline case, and a boot that refused here would make moat unusable on a plane.
  for (const catalog of [null, catalogWith({})]) {
    const facts = resolveModelFacts({ catalog, providerID: "deepseek", modelID: "deepseek-flash", providerIsNative: true })
    assert.equal(facts.id, "deepseek-flash")
    assert.equal(facts.displayName, "deepseek-flash")
    assert.equal(facts.contextWindow, undefined)
    assert.deepEqual(renderCatalogFromFacts(facts), renderCatalogFromFacts(
      resolveModelFacts({ catalog: null, providerID: "deepseek", modelID: "deepseek-flash", providerIsNative: true }),
    ), "with no catalog the answer does not depend on which empty one it was")
  }
})

test("a provider's own reasoning ladder wins over moat's default", () => {
  // models.dev says whether a model reasons and nothing finer, so the ladder is the one fact
  // neither catalog can supply. A provider that implements `none`/`medium` declares it rather
  // than being offered `max` and having Codex drop it.
  const facts = resolveModelFacts({
    catalog: DESCRIBED,
    providerID: "acme",
    modelID: "acme-large",
    providerIsNative: false,
    effortLevels: ["none", "medium"],
    defaultEffort: "medium",
  })
  assert.deepEqual(facts.effortLevels, ["none", "medium"])
  assert.equal(facts.defaultEffort, "medium")
  const entry = JSON.parse(renderCatalogFromFacts(facts)).models[0]
  assert.deepEqual(
    entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort),
    ["none", "medium"],
  )
  assert.equal(entry.default_reasoning_level, "medium")

  // Without one, moat's default ladder is used and it is never empty — an empty ladder would
  // render a catalog with no levels, which Codex accepts and then cannot reason with.
  const plain = resolveModelFacts({ catalog: null, providerID: "moat", modelID: "m", providerIsNative: false })
  assert.deepEqual(plain.effortLevels, defaultEffortLevels())
  assert.ok(plain.effortLevels.length > 0)
})

test("--effort is checked against the model's own levels, and the message says which", () => {
  assert.equal(checkEffort("high", ["low", "high", "max"]), null)
  const problem = checkEffort("max", ["none", "medium"])
  assert.ok(problem)
  assert.match(problem, /--effort "max"/)
  assert.match(problem, /none, medium/, "the message names the levels this model does declare")
  assert.match(problem, /models\.dev describes whether a model reasons/, "and why the ladder is moat's own")
  // The default ladder is the one moat has always offered.
  assert.deepEqual(defaultEffortLevels(), ["low", "high", "max"])
})

test("the facts record is the only thing the two readers are given", () => {
  // A structural guard rather than a behavioural one: `catalogEntryFromFacts` is what turns the
  // record into the runtime's schema, so a second path that builds an entry from something else
  // would be a second description of the model. Both exports take a `ModelFacts` and nothing
  // that could carry a competing context window or name.
  const facts = resolveModelFacts({ catalog: DESCRIBED, providerID: "deepseek", modelID: "deepseek-flash", providerIsNative: true })
  const direct = catalogEntryFromFacts(facts)
  const rendered = JSON.parse(renderCatalogFromFacts(facts)).models[0]
  for (const field of ["slug", "display_name", "context_window", "max_output_tokens", "default_reasoning_level"]) {
    assert.deepEqual(rendered[field], (direct as Record<string, unknown>)[field], field)
  }
  // A provider override reaches the entry but cannot rename the model out from under the facts.
  const overridden = catalogEntryFromFacts(facts, { overrides: { shell_type: "unified_exec" } })
  assert.equal(overridden.shell_type, "unified_exec")
  assert.equal(overridden.slug, facts.id)
  assert.equal(overridden.display_name, facts.displayName)
  assert.equal(overridden.context_window, facts.contextWindow)
})
