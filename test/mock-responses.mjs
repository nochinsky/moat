import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"

/*
 * A keyless OpenAI **Responses** stub, for Codex.
 *
 * The other stub (test/mock-model.mjs) speaks chat completions for opencode. Codex only
 * speaks the Responses wire API, so a keyless suite cannot drive it without this. Every
 * event shape below was copied from a real DeepSeek stream captured through a recording
 * proxy (2 turns, 13 event types: response.created/in_progress, output_item.added/done,
 * content_part.added/done, output_text.delta/done, function_call_arguments.delta/done,
 * response.completed), including the usage fields Codex reports:
 *   {"input_tokens": N, "input_tokens_details": {"cached_tokens": N},
 *    "output_tokens": N, "output_tokens_details": {"reasoning_tokens": N}, "total_tokens": N}
 *
 * Usage: node test/mock-responses.mjs --port 5599 --script test/scripts/responses-basic.json
 *        [--record /tmp/responses-requests.jsonl]
 */

const args = process.argv.slice(2)
const flagOf = (name, fallback) => {
  const i = args.indexOf("--" + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const port = Number(flagOf("port", "5599"))
const scriptPath = flagOf("script", "test/scripts/responses-basic.json")
const recordPath = flagOf("record", "")
const script = JSON.parse(fs.readFileSync(scriptPath, "utf8"))
const turns = Array.isArray(script.turns) ? script.turns : []
if (turns.length === 0) {
  console.error("script needs at least one turn")
  process.exit(1)
}

const model = script.model || "mock-model"
let requestCount = 0
const record = recordPath ? fs.createWriteStream(recordPath, { flags: "a" }) : null

const usage = () => ({
  input_tokens: 8600,
  input_tokens_details: { cached_tokens: 8400 },
  output_tokens: 40,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 8640,
})

const responseShell = (status, output) => ({
  id: "resp_" + crypto.randomBytes(8).toString("hex"),
  object: "response",
  created_at: Math.floor(Date.now() / 1000),
  status,
  background: false,
  error: null,
  incomplete_details: null,
  instructions: null,
  max_output_tokens: null,
  max_tool_calls: null,
  model,
  output: output || [],
  parallel_tool_calls: true,
  previous_response_id: null,
  prompt_cache_key: null,
  reasoning: null,
  safety_identifier: null,
  service_tier: "default",
  store: false,
  temperature: 1,
  text: null,
  tool_choice: "auto",
  tools: [],
  top_logprobs: 0,
  top_p: 1,
  truncation: "disabled",
  usage: status === "completed" ? usage() : null,
  user: null,
  metadata: {},
  moderation: null,
  frequency_penalty: 0,
  presence_penalty: 0,
  content_filters: [],
  completed_at: status === "completed" ? Math.floor(Date.now() / 1000) : null,
})

function sse(res, type, payload, seq) {
  res.write("event: " + type + "\n")
  res.write("data: " + JSON.stringify({ type, ...payload, sequence_number: seq }) + "\n\n")
}

function chunks(text, size = 24) {
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out.length > 0 ? out : [""]
}

function streamTurn(res, turn) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
  let seq = 0
  sse(res, "response.created", { response: responseShell("in_progress", []) }, seq++)
  sse(res, "response.in_progress", { response: responseShell("in_progress", []) }, seq++)
  const output = []
  if (turn.tool) {
    const callId = "call_mock_" + crypto.randomBytes(6).toString("hex")
    const itemId = crypto.randomUUID()
    const item = {
      type: "function_call",
      id: itemId,
      status: "completed",
      arguments: JSON.stringify(turn.tool),
      call_id: callId,
      name: turn.toolName || "exec_command",
    }
    sse(res, "response.output_item.added", { item: { ...item, arguments: "", status: "in_progress" }, output_index: 0 }, seq++)
    for (const piece of chunks(item.arguments, 16)) {
      sse(res, "response.function_call_arguments.delta", { delta: piece, item_id: itemId, output_index: 0 }, seq++)
    }
    sse(res, "response.function_call_arguments.done", { arguments: item.arguments, item_id: itemId, output_index: 0 }, seq++)
    sse(res, "response.output_item.done", { item, output_index: 0 }, seq++)
    output.push(item)
  } else {
    const text = turn.text || "Done."
    const itemId = crypto.randomUUID()
    const message = {
      type: "message",
      id: itemId,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", annotations: [], logprobs: [], text }],
    }
    sse(res, "response.output_item.added", { item: { ...message, status: "in_progress", content: [] }, output_index: 0 }, seq++)
    sse(res, "response.content_part.added", { content_index: 0, item_id: itemId, output_index: 0, part: { type: "output_text", annotations: [], logprobs: [], text: "" } }, seq++)
    for (const piece of chunks(text)) {
      sse(res, "response.output_text.delta", { content_index: 0, delta: piece, item_id: itemId, logprobs: [], output_index: 0 }, seq++)
    }
    sse(res, "response.output_text.done", { content_index: 0, item_id: itemId, logprobs: [], output_index: 0, text }, seq++)
    sse(res, "response.content_part.done", { content_index: 0, item_id: itemId, output_index: 0, part: { type: "output_text", annotations: [], logprobs: [], text } }, seq++)
    sse(res, "response.output_item.done", { item: message, output_index: 0 }, seq++)
    output.push(message)
  }
  sse(res, "response.completed", { response: responseShell("completed", output) }, seq++)
  res.end()
}

const server = http.createServer((req, res) => {
  const body = []
  req.on("data", (c) => body.push(c))
  req.on("end", () => {
    const text = Buffer.concat(body).toString("utf8")
    if (record) {
      // Record what a test would assert on, parsed, rather than a truncated body: the
      // interesting fields (model, reasoning) sit behind the long instructions block.
      let summary = { url: req.url, parseError: null }
      try {
        const parsed = JSON.parse(text)
        summary = {
          url: req.url,
          model: parsed.model,
          reasoning: parsed.reasoning ?? null,
          toolChoice: parsed.tool_choice ?? null,
          tools: (parsed.tools ?? []).map((t) => t.name ?? t.type),
          inputCount: Array.isArray(parsed.input) ? parsed.input.length : null,
          lastInput: Array.isArray(parsed.input) ? parsed.input[parsed.input.length - 1] : null,
          // The whole instructions block: a test may need to prove that a brief reached the
          // model (the AGENTS.md discovery path), and the marker can sit anywhere in it.
          instructions: typeof parsed.instructions === "string" ? parsed.instructions : null,
          // The raw body too: an AGENTS.md brief arrives wrapped in the conversation, not in
          // the instructions field, so a test that greps the body is the one that proves it.
          body: text.length > 200000 ? text.slice(0, 200000) : text,
        }
      } catch (error) {
        summary.parseError = String(error)
      }
      record.write(JSON.stringify(summary) + "\n")
    }
    if (!/\/responses$/.test((req.url || "").split("?")[0] || "")) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "the responses mock only serves /responses" } }))
      return
    }
    const turn = turns[Math.min(requestCount, turns.length - 1)]
    requestCount += 1
    streamTurn(res, turn)
  })
})
server.listen(port, "127.0.0.1", () => {
  console.log("[mock-responses] listening on http://127.0.0.1:" + port + "/v1/responses (" + turns.length + " scripted turn(s))")
})
