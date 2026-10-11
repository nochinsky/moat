import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { piExecBody, piTuiBody, parsePiEvents, createPiEventParser, renderPiFiles } from "../../bundle/pi.ts"
import { PI_RUNTIME, keepaliveEntryScript } from "../../bundle/runtime.ts"
import { resolveModelFacts } from "../../lib/model-facts.ts"
import { SPEC, parse } from "../../lib/flags.ts"

const jsonl = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n"
const usage = { input: 100, output: 50, cacheRead: 200, cacheWrite: 10, reasoning: 20 }
const message = { role: "assistant", model: "model", provider: "moat", stopReason: "stop", content: [{ type: "text", text: "hello\u2028world" }], usage }

test("one tool lifecycle is one row; custom tools and completed messages are retained", () => {
  const turn = parsePiEvents(jsonl(
    { type: "message_update", usage, assistantMessageEvent: { type: "text_delta", delta: "hello" } },
    { type: "tool_execution_start", toolCallId: "a", toolName: "ticket", args: { query: "ticket 123" } },
    { type: "tool_execution_end", toolCallId: "a", toolName: "ticket", isError: true, result: { content: [{ type: "text", text: "missing" }] } },
    { type: "message_end", message },
    { type: "turn_end", message },
    { type: "agent_end", messages: [message] },
    { type: "agent_settled", aborted: false },
  ))
  assert.equal(turn.tools.length, 1)
  assert.deepEqual(turn.tools[0], { id: "a", kind: "ticket", detail: "ticket 123", status: "completed", exitCode: 1, output: "missing" })
  assert.deepEqual(turn.messages, ["hello\u2028world"])
  assert.deepEqual(turn.usage, { input: 110, cached: 200, output: 30, reasoning: 20 })
})
test("streaming usage is cumulative, final usage is authoritative, and independent requests add", () => {
  assert.deepEqual(parsePiEvents(jsonl({ type: "message_update", usage }, { type: "message_update", usage })).usage, { input: 110, cached: 200, output: 30, reasoning: 20 })
  const text = jsonl({ type: "message_end", message }, { type: "message_update", usage }, { type: "message_end", message })
  assert.deepEqual(parsePiEvents(text).usage, { input: 220, cached: 400, output: 60, reasoning: 40 })
})
test("incremental framing preserves accounting across chunk boundaries and long raw captures", () => {
  const parser = createPiEventParser()
  const first = jsonl({ type: "message_end", message })
  for (let i = 0; i < first.length; i += 3) parser.feed(first.slice(i, i + 3))
  // More than runInSandbox retains. Diagnostic truncation must not erase earlier usage.
  for (let i = 0; i < 90; i++) parser.feed(jsonl({ type: "ignored", text: "x".repeat(65536) }))
  parser.feed(first)
  assert.deepEqual(parser.finish().usage, { input: 220, cached: 400, output: 60, reasoning: 40 })
})
test("bounded report text does not truncate usage or conflate providers with the same model id", () => {
  const parser = createPiEventParser()
  for (let i = 0; i < 80; i++) parser.feed(jsonl({ type: "message_end", message: { ...message, content: [{ type: "text", text: "x".repeat(65536) }] } }))
  parser.feed(jsonl({ type: "message_start", message: { ...message, provider: "other" } }))
  const turn = parser.finish()
  assert.equal(turn.messages.join("").length, 4 * 1024 * 1024)
  assert.deepEqual(turn.usage, { input: 8800, cached: 16000, output: 2400, reasoning: 1600 })
  assert.deepEqual(turn.models, ["moat/model", "other/model"])
  assert.match(turn.notices.join(""), /truncated/)
})
test("an oversized event is a failure, not an apparently successful empty report", () => {
  const parser = createPiEventParser()
  for (let i = 0; i < 17; i++) parser.feed("x".repeat(1024 * 1024))
  parser.feed("\n" + jsonl({ type: "message_end", message }))
  assert.match(parser.problem() ?? "", /parsing limit/)
  assert.equal(parser.finish().errors.length, 1)
})
test("compaction and nested model usage count, but do not duplicate tool-result snapshots", () => {
  const turn = parsePiEvents(jsonl({ type: "message_end", message }, { type: "compaction_end", result: { usage } }, { type: "message_end", message: { role: "toolResult", usage } }))
  assert.deepEqual(turn.usage, { input: 330, cached: 600, output: 90, reasoning: 60 })
})
test("an error or abort in a zero-exit Pi stream is an error; a successful retry clears transient errors", () => {
  const error = { ...message, stopReason: "error", errorMessage: "bad API key" }
  assert.deepEqual(parsePiEvents(jsonl({ type: "message_end", message: error })).errors, ["bad API key"])
  assert.deepEqual(parsePiEvents(jsonl({ type: "message_end", message: error }, { type: "message_end", message })).errors, [])
  assert.deepEqual(parsePiEvents(jsonl({ type: "agent_settled", aborted: true })).errors, ["Pi run was aborted"])
})
test("malformed/unknown records are ignored and numerical poison cannot trip accounting", () => {
  assert.equal(parsePiEvents("noise\n{\n").usage, null)
  assert.deepEqual(parsePiEvents(jsonl({ type: "unknown", usage }, { type: "message_end", message: { ...message, usage: { input: -1, output: "100", cacheRead: null } } })).usage, { input: 0, output: 0, cached: 0, reasoning: 0 })
})
test("Pi is the only runtime; --runtime is refused, not accepted and ignored", () => {
  assert.equal(PI_RUNTIME.label, "pi")
  assert.throws(() => parse(["--runtime", "codex"], SPEC, "up"), /unknown flag/)
})
test("both bodies use the sandbox, trust copied project extensions, and never use argv for credentials", () => {
  for (const body of [piExecBody("'; $(touch /tmp/nope)\nfix -x"), piTuiBody()]) {
    assert.match(body, /cd \/work/)
    assert.match(body, /PI_CODING_AGENT_DIR=\/root\/\.pi\/agent/)
    assert.match(body, /--approve --offline/)
    assert.match(body, /--model "\$MOAT_MODEL" --thinking "\$MOAT_REASONING_EFFORT"/)
    assert.doesNotMatch(body, /--api-key|--no-extensions|--no-skills|--no-session/)
    assert.equal(spawnSync("sh", ["-n"], { input: body }).status, 0)
  }
  assert.match(piExecBody("task"), /--mode json -- 'task' <\/dev\/null/)
  assert.doesNotMatch(keepaliveEntryScript(), /codex|claude/)
})
test("provider config is explicit; credentials are only env references; keyless disables auth", () => {
  const facts = resolveModelFacts({ catalog: null, providerID: "acme", modelID: "model", providerIsNative: false })
  for (const wireApi of ["chat", "responses"] as const) {
    const files = renderPiFiles({ facts, providerID: "acme", baseURL: "https://acme.example/v1", wireApi, envKey: "ACME_KEY" })
    const provider = JSON.parse(files.catalog).providers.acme
    assert.equal(provider.apiKey, "$ACME_KEY")
    assert.equal(provider.authHeader, true)
    assert.equal(provider.api, wireApi === "chat" ? "openai-completions" : "openai-responses")
    assert.equal(JSON.parse(files.config).cacheWarming, "off")
  }
  const keyless = JSON.parse(renderPiFiles({ facts, providerID: "acme", baseURL: "http://localhost:1" }).catalog).providers.acme
  assert.equal(keyless.authHeader, false)
  assert.equal(keyless.apiKey, "moat-keyless")
})
