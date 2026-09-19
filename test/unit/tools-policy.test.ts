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
