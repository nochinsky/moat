#!/usr/bin/env node
// The keyless model stub for a Claude Code turn.
//
// Codex speaks the Responses wire API, so `stub/mock-responses.mjs` replays the event shapes
// captured from a real DeepSeek stream. Claude Code speaks the Anthropic Messages API with server-
// sent events, so this is the same idea against a different wire: it records the request it
// received (so a test reads what the provider *would* have seen rather than what moat says it
// sent), then serves a scripted turn.
//
// The script is fixed and deterministic: the first request asks to run a `Bash` command, and once
// the tool result comes back it answers and stops. That is the smallest turn that proves the whole
// path — the box asked for a tool, the tool ran, and the agent finished — with no credential.
//
// Usage: node stub/mock-anthropic.mjs --port 5611 [--record file.jsonl]
import fs from "node:fs"
import http from "node:http"

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const port = Number(arg("--port", "5611"))
const record = arg("--record", "")
const model = arg("--model", "claude-stub")
const command = arg("--command", "echo stub-tool-ran")

function log(entry) {
  if (record) fs.appendFileSync(record, JSON.stringify(entry) + "\n")
}

function sse(res, events) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
}

function messageStart(id, usage) {
  return ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, usage } }]
}

/** A text block, as the CLI's stream-json reduces it to one `assistant` event. */
function textTurn(text, usage) {
  return [
    messageStart("msg_stub_text", usage),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }],
    ["message_stop", { type: "message_stop" }],
  ]
}

/** A tool call, which is what makes the box actually run something. */
function toolTurn(usage) {
  const input = JSON.stringify({ command, description: "prove the tool ran" })
  return [
    messageStart("msg_stub_tool", usage),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Running the check." } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_stub_1", name: "Bash", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: input } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ]
}

http
  .createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        /* not JSON: recorded as null, which is itself worth seeing */
      }
      log({
        path: req.url,
        method: req.method,
        // What the provider actually received — the thing a test asserts on, not moat's account.
        apiKey: req.headers["x-api-key"] ?? null,
        authorization: req.headers["authorization"] ?? null,
        body: parsed,
      })
      if (!String(req.url).startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: String(req.url) } }))
        return
      }
      // The turn: ask for a tool first, then answer once the tool result is in the conversation.
      const messages = JSON.stringify(parsed?.messages ?? [])
      const usage = { input_tokens: 120, output_tokens: 0, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 }
      if (messages.includes("tool_result")) sse(res, textTurn("Done: the tool ran.", { input_tokens: 240, output_tokens: 0 }))
      else sse(res, toolTurn(usage))
    })
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`[mock-anthropic] http://127.0.0.1:${port}  (record: ${record || "none"})`)
  })
