import assert from "node:assert/strict"
import { test } from "node:test"

import { CODEX_EFFORT_LEVELS, renderCodexConfig } from "../../bundle/codex.ts"

const base = { model: "deepseek-flash", providerID: "deepseek-moat", baseURL: "https://api.deepseek.com", envKey: "DEEPSEEK_API_KEY" }

test("a reasoning effort is rendered only for the levels Codex accepts", () => {
  // Codex takes minimal/low/medium/high. The opencode runtime also has `max` and `off`;
  // passing those through would be an invalid enum, so they are omitted.
  for (const level of CODEX_EFFORT_LEVELS) {
    const config = renderCodexConfig({ ...base, reasoningEffort: level })
    assert.match(config, new RegExp("^model_reasoning_effort = \"" + level + "\"$", "m"))
  }
  for (const level of ["max", "off", "extreme", ""]) {
    const config = renderCodexConfig({ ...base, reasoningEffort: level })
    assert.ok(!/model_reasoning_effort/.test(config), "level " + JSON.stringify(level) + " must be omitted")
  }
  assert.ok(!/model_reasoning_effort/.test(renderCodexConfig(base)))
})
