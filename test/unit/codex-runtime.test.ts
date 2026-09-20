import assert from "node:assert/strict"
import { test } from "node:test"

import { describeCodexTurn, parseCodexEvents, renderCodexConfig } from "../../bundle/codex.ts"

// A real `codex exec --json` stream, captured from the sandbox during the spike
// (docs/RUNTIME-SPIKE-codex.md): the start/completion pair for one command, the answer,
// the metadata notice, and the usage line.
const SAMPLE = [
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `deepseek-v4-pro` not found. Defaulting to fallback metadata."}}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/sh -c \\"printf hello > CODEX-SPIKE.txt\\"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/sh -c \\"printf hello > CODEX-SPIKE.txt\\"","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Created /work/CODEX-SPIKE.txt with contents exactly hello."}}',
  '{"type":"turn.completed","usage":{"input_tokens":18118,"cached_input_tokens":9088,"cache_write_input_tokens":0,"output_tokens":238,"reasoning_output_tokens":0}}',
].join("\n")

test("a real codex exec stream becomes one row per tool, the answer, and usage", () => {
  const turn = parseCodexEvents(SAMPLE)
  assert.equal(turn.tools.length, 1, "the start and the completion are one row")
  assert.equal(turn.tools[0]!.kind, "command_execution")
  assert.equal(turn.tools[0]!.status, "completed")
  assert.equal(turn.tools[0]!.exitCode, 0)
  assert.match(turn.tools[0]!.detail, /CODEX-SPIKE\.txt/)
  assert.deepEqual(turn.messages, ["Created /work/CODEX-SPIKE.txt with contents exactly hello."])
  // `input_tokens` includes the cached ones: 18118 total prompt, 9088 of it cache hits, so
  // the cache-*miss* count is 9030. Charging both fields would double count the hits.
  assert.deepEqual(turn.usage, { input: 9030, cached: 9088, output: 238, reasoning: 0 })
  assert.equal(turn.errors.length, 1, "the metadata notice is reported, not swallowed")
})

test("events that carry no item are not invented, and junk lines are skipped", () => {
  const turn = parseCodexEvents(["{\"type\":\"turn.started\"}", "not json", "", "{\"type\":\"turn.completed\"}"].join("\n"))
  assert.deepEqual(turn.tools, [])
  assert.deepEqual(turn.errors, [])
  assert.deepEqual(turn.usage, { input: 0, cached: 0, output: 0, reasoning: 0 })
})

test("a failed tool is counted, and describeCodexTurn says so", () => {
  const stream = [
    '{"type":"item.completed","item":{"id":"a","type":"command_execution","command":"false","exit_code":1}}',
    '{"type":"item.completed","item":{"id":"b","type":"command_execution","command":"true","exit_code":0}}',
  ].join("\n")
  const turn = parseCodexEvents(stream)
  assert.equal(turn.tools.length, 2)
  assert.match(describeCodexTurn(turn), /2 tools/)
  assert.match(describeCodexTurn(turn), /1 failed/)
})

test("the rendered config turns approvals and codex's own sandbox off, per provider block", () => {
  const config = renderCodexConfig({
    model: "deepseek-v4-pro",
    providerID: "deepseek-moat",
    baseURL: "https://api.deepseek.com",
    envKey: "DEEPSEEK_API_KEY",
    contextWindow: 131072,
    maxOutputTokens: 32768,
  })
  assert.match(config, /^model = "deepseek-v4-pro"$/m)
  assert.match(config, /^model_provider = "deepseek-moat"$/m)
  assert.match(config, /^approval_policy = "never"$/m)
  assert.match(config, /^sandbox_mode = "danger-full-access"$/m)
  assert.match(config, /^model_context_window = 131072$/m)
  assert.match(config, /^model_max_output_tokens = 32768$/m)
  assert.match(config, /^\[model_providers\.deepseek-moat\]$/m)
  assert.match(config, /^base_url = "https:\/\/api\.deepseek\.com"$/m)
  assert.match(config, /^env_key = "DEEPSEEK_API_KEY"$/m)
  assert.match(config, /^wire_api = "responses"$/m)
  // The file the agent can read must never carry the key itself.
  assert.ok(!/sk-/.test(config))
  const withoutWindow = renderCodexConfig({ model: "m", providerID: "p", baseURL: "http://x", envKey: "K" })
  assert.ok(!/model_context_window/.test(withoutWindow))
  assert.match(withoutWindow, /^base_url = "http:\/\/x"$/m)
})

test("a provider id that is not a TOML key is refused rather than quoted wrongly", () => {
  assert.throws(
    () => renderCodexConfig({ model: "m", providerID: "bad id", baseURL: "http://x", envKey: "K" }),
    /invalid codex provider id/,
  )
})
