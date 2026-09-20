import assert from "node:assert/strict"
import crypto from "node:crypto"
import { test } from "node:test"

import { CATALOG_INSTRUCTIONS_SHA256, CODEX_CATALOG } from "../../bundle/codex.ts"

test("the vendored catalog carries Codex's own prompt, pinned by digest", () => {
  // The catalog schema requires `base_instructions` or `model_messages.instructions_template`
  // (measured: Codex 0.155.1 refuses a catalog with neither). moat pins Codex's own built-in
  // prompt in that field, so carrying the catalog does not change what the agent is told --
  // DeepSeek's copy of that field is a different text and would silently replace the prompt.
  // A future refresh of the vendored file must not be able to swap it unnoticed, and a Codex
  // version bump can move the built-in prompt, so the pin has to move in the same commit.
  assert.ok(CODEX_CATALOG.models.length >= 2, "both live models are described")
  for (const model of CODEX_CATALOG.models) {
    const text = (model as { base_instructions?: string }).base_instructions ?? ""
    const sha = crypto.createHash("sha256").update(text).digest("hex")
    assert.equal(sha, CATALOG_INSTRUCTIONS_SHA256, model.slug + " carries the pinned prompt")
    assert.equal("model_messages" in model, false, model.slug + " keeps the second prompt field out")
  }
})
