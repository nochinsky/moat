import assert from "node:assert/strict"
import crypto from "node:crypto"
import { test } from "node:test"

import {
  CATALOG_INSTRUCTIONS_SHA256,
  CODEX_CATALOG,
  catalogAllEffortLevels,
  describeCodexTurn,
  parseCodexEvents,
  renderCodexConfig,
} from "../../bundle/codex.ts"

// A real `codex exec --json` stream, captured from the sandbox during the spike
// (`docs/HISTORY.md`): the start/completion pair for one command, the answer,
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
  // The metadata advisory is not a failure: counting it made a good run read "1 error".
  assert.deepEqual(turn.errors, [])
  assert.equal(turn.notices.length, 1, "the advisory is kept, not swallowed")
})

test("events that carry no item are not invented, and junk lines are skipped", () => {
  const turn = parseCodexEvents(["{\"type\":\"turn.started\"}", "not json", "", "{\"type\":\"turn.completed\"}"].join("\n"))
  assert.deepEqual(turn.tools, [])
  assert.deepEqual(turn.errors, [])
  assert.deepEqual(turn.notices, [])
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
    reasoningEffort: "high",
  })
  assert.match(config, /^model = "deepseek-v4-pro"$/m)
  assert.match(config, /^model_provider = "deepseek-moat"$/m)
  assert.match(config, /^approval_policy = "never"$/m)
  assert.match(config, /^sandbox_mode = "danger-full-access"$/m)
  // DeepSeek's documented setup: API key only, no ChatGPT/OpenAI account path.
  assert.match(config, /^preferred_auth_method = "apikey"$/m)
  assert.match(config, /^forced_login_method = "api"$/m)
  // The vendored catalog is what removes the "Model metadata for ... not found" fallback and is
  // what makes model_reasoning_effort mean anything; the box file is written by installCodexFiles
  // at exactly this path.
  assert.match(config, /^model_catalog_json = "\/root\/\.codex\/models\.json"$/m)
  // DeepSeek's API accepts a web_search tool and ignores it (measured live): advertise nothing.
  assert.match(config, /^web_search = "disabled"$/m)
  assert.match(config, /^model_context_window = 131072$/m)
  assert.match(config, /^model_max_output_tokens = 32768$/m)
  assert.match(config, /^model_reasoning_effort = "high"$/m)
  assert.match(config, /^\[model_providers\.deepseek-moat\]$/m)
  assert.match(config, /^base_url = "https:\/\/api\.deepseek\.com"$/m)
  assert.match(config, /^env_key = "DEEPSEEK_API_KEY"$/m)
  assert.match(config, /^wire_api = "responses"$/m)
  // The file the agent can read must never carry the key itself.
  assert.ok(!/sk-/.test(config))
  const withoutWindow = renderCodexConfig({ model: "m", providerID: "p", baseURL: "http://x", envKey: "K" })
  assert.ok(!/model_context_window/.test(withoutWindow))
  assert.ok(!/model_reasoning_effort/.test(withoutWindow), "no effort asked for means no effort rendered")
  assert.match(withoutWindow, /^base_url = "http:\/\/x"$/m)
  const low = renderCodexConfig({ model: "m", providerID: "p", baseURL: "http://x", envKey: "K", reasoningEffort: "low" })
  assert.match(low, /^model_reasoning_effort = "low"$/m)
})

test("the vendored catalog carries codex's own built-in prompt, so it changes metadata only", () => {
  // Codex refuses an entry with neither base_instructions nor model_messages.instructions_template
  // (measured; see the comment in bundle/codex.ts), so the field stays. It must stay the prompt
  // the pinned binary sends for a model it has no metadata for, or installing the catalog would
  // silently change the agent's system prompt. The sha is the pin; a refreshed catalog that swaps
  // the prompt fails here instead of reaching the wire.
  for (const model of CODEX_CATALOG.models) {
    const sha = crypto.createHash("sha256").update(model.base_instructions).digest("hex")
    assert.equal(sha, CATALOG_INSTRUCTIONS_SHA256, model.slug + " base_instructions")
  }
  assert.equal(
    CODEX_CATALOG.models[0]!.base_instructions,
    CODEX_CATALOG.models[1]!.base_instructions,
    "the built-in prompt is model-independent (measured)",
  )
  assert.ok(
    CODEX_CATALOG.models.every((model) => !("model_messages" in model)),
    "model_messages stays dropped: its instructions_template is the same prompt",
  )
  // The levels --effort is validated against come from the catalog, not a list in the CLI.
  assert.deepEqual(catalogAllEffortLevels(), ["high", "low", "max"])
})

test("a provider id that is not a TOML key is refused rather than quoted wrongly", () => {
  assert.throws(
    () => renderCodexConfig({ model: "m", providerID: "bad id", baseURL: "http://x", envKey: "K" }),
    /invalid codex provider id/,
  )
})

test("a token count that is not a positive integer never reaches the TOML bare", () => {
  // The count comes from a fetched catalog (`lib/catalog.ts`), and these two lines are the only
  // unquoted numbers moat writes. Interpolated raw, a value JSON can hold but TOML cannot read
  // produced a config Codex refuses: `model_context_window = NaN` is a parse error naming a line
  // the user never wrote, and `Infinity` is not TOML either. The line is optional — Codex falls
  // back to its own metadata — so an unusable count is dropped, not written.
  const bad: unknown[] = [NaN, Infinity, -Infinity, 1e999, -1, 0, 1.5, "131072", null, {}, []]
  for (const value of bad) {
    const config = renderCodexConfig({
      model: "m",
      providerID: "p",
      baseURL: "http://x",
      envKey: "K",
      contextWindow: value as number,
      maxOutputTokens: value as number,
    })
    assert.ok(!/model_context_window/.test(config), `contextWindow=${String(value)} was rendered`)
    assert.ok(!/model_max_output_tokens/.test(config), `maxOutputTokens=${String(value)} was rendered`)
    // The rest of the config still renders: a bad count is not a failed boot.
    assert.match(config, /^model = "m"$/m)
    assert.match(config, /^approval_policy = "never"$/m)
  }
  // The honest values still render, and as integers.
  const good = renderCodexConfig({ model: "m", providerID: "p", baseURL: "http://x", contextWindow: 131072, maxOutputTokens: 32768 })
  assert.match(good, /^model_context_window = 131072$/m)
  assert.match(good, /^model_max_output_tokens = 32768$/m)
})

test("two items with no id are two rows, not one", () => {
  // The synthetic id was `item-<turn.tools.length>`, and the length does not change
  // between the two events of the pair, so a second id-less item merged into the
  // first row: one tool reported where the stream described two, with the first
  // command's detail and the second one's exit code, and the footer's count wrong.
  const stream = [
    '{"type":"item.started","item":{"type":"command_execution","command":"first"}}',
    '{"type":"item.completed","item":{"type":"command_execution","command":"first","exit_code":0}}',
    '{"type":"item.completed","item":{"type":"command_execution","command":"second","exit_code":7}}',
  ].join("\n")
  const turn = parseCodexEvents(stream)
  assert.equal(turn.tools.length, 2, "one row per item, not one row for both")
  assert.deepEqual(
    turn.tools.map((tool) => tool.detail),
    ["first", "second"],
  )
  assert.equal(turn.tools[0]!.exitCode, 0)
  assert.equal(turn.tools[1]!.exitCode, 7, "the second item's exit code belongs to the second row")
  assert.match(describeCodexTurn(turn), /2 tools/)
  // A synthetic id must not be able to collide with a real one: a row the parser
  // invented and a row Codex named are two rows, whichever order they arrive in.
  const mixed = [
    '{"type":"item.started","item":{"type":"command_execution","command":"no id here"}}',
    '{"type":"item.completed","item":{"id":"item-synthetic-0","type":"command_execution","command":"real id","exit_code":3}}',
  ].join("\n")
  const mixedTurn = parseCodexEvents(mixed)
  assert.equal(mixedTurn.tools.length, 2, "an invented id must not swallow a real one")
  assert.equal(mixedTurn.tools[1]!.detail, "real id")
  assert.equal(mixedTurn.tools[1]!.exitCode, 3)
})
