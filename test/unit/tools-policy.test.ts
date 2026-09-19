import assert from "node:assert/strict"
import { test } from "node:test"

import { assertInvariants, renderBundle } from "../../bundle/render.ts"
import { CURATED_TOOLS, EXCLUDED_TOOLS } from "../../lib/pins.ts"

test("the curated tool list has one source of truth", () => {
  assert.ok(CURATED_TOOLS.includes("question" as never), "question is curated by the renderer")
  assert.equal(EXCLUDED_TOOLS.includes("question"), false)

  const rendered = renderBundle({
    provider: { opencodeID: "deepseek", npm: "", native: true },
    modelID: "deepseek-flash",
    baseUrl: "",
    preset: "core",
  })
  assert.deepEqual(rendered.curated, [...CURATED_TOOLS])
  assert.deepEqual([...rendered.excluded].sort(), [...EXCLUDED_TOOLS].sort())
  assert.doesNotThrow(() => assertInvariants(rendered))
})

test("the permission invariant is exactly allow-all, not merely non-deny", () => {
  const rendered = renderBundle({
    provider: { opencodeID: "deepseek", npm: "", native: true },
    modelID: "deepseek-flash",
    baseUrl: "",
    preset: "core",
  })
  const withPermission = (permission: Record<string, string>) => ({
    ...rendered,
    config: JSON.stringify({ ...(JSON.parse(rendered.config) as Record<string, unknown>), permission }),
  })
  // The old assertion only rejected the literal value "deny", so an approval
  // rule slipped through what the docs call "and nothing else".
  assert.throws(() => assertInvariants(withPermission({ "*": "allow", bash: "ask" })), /exactly/)
  assert.throws(() => assertInvariants(withPermission({ "*": "allow", bash: "deny" })), /exactly/)
  assert.throws(() => assertInvariants(withPermission({})), /exactly/)
})
