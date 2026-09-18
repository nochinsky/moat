#!/usr/bin/env node
/**
 * A deterministic, hermetic OpenAI-compatible model server.
 *
 * WHY THIS EXISTS: this host has no model credentials at all, `env | grep -i
 * api_key` is empty and there is no ~/.local/share/opencode/auth.json. Rather
 * than assert that "the agent works" without evidence, moat's verification
 * suite drives the REAL opencode agent loop (real session, real tool
 * dispatcher, real permission checks, real bash and file edits inside the
 * sandbox) with a scripted model. Every tool call in the transcript below is
 * executed by opencode itself, inside the box.
 *
 * It is an instrument, not a mock of moat: it sits exactly where a real
 * OpenAI-compatible endpoint would, at the far end of the injected credential.
 *
 * It also records:
 *   - the Authorization header it receives (proves credential injection end to
 *     end, and that the value came from the broker rather than the image),
 *   - the tool definitions opencode advertises on each request (proves the
 *     curated bundle is what the model is actually offered).
 *
 * Usage: node test/mock-model.mjs --port 5599 --script test/scripts/basic.json
 */
import http from "node:http"
import fs from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const get = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const port = Number(get("port", "5599"))
const scriptPath = get("script", null)
const recordPath = get("record", "/tmp/moat-mock-model.jsonl")
const modelName = get("model", "mock-model")

const script = scriptPath
  ? JSON.parse(fs.readFileSync(scriptPath, "utf8"))
  : [{ text: "no script supplied" }]

function record(entry) {
  fs.mkdirSync(path.dirname(recordPath), { recursive: true })
  fs.appendFileSync(recordPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
}

function sseChunk(response, delta, finish = null) {
  const payload = {
    id: "chatcmpl-moat",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** Count how many assistant turns have already happened. */
function assistantTurns(messages) {
  return messages.filter((m) => m.role === "assistant").length
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")

  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ object: "list", data: [{ id: modelName, object: "model", owned_by: "moat" }] }))
    return
  }

  if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url.pathname}` } }))
    return
  }

  const body = await new Promise((resolve) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}))
  })

  const authorization = req.headers.authorization ?? null
  const tools = (body.tools ?? []).map((t) => t.function?.name).filter(Boolean).sort()
  // Does the request carry moat's environment brief? This is how we check that
  // /root/.config/opencode/AGENTS.md is actually READ by opencode, rather than
  // merely written into the rootfs.
  const systemText = (body.messages ?? [])
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    .join("\n")
  const turns = assistantTurns(body.messages ?? [])
  const step = script[Math.min(turns, script.length - 1)]

  record({
    path: url.pathname,
    authorization,
    model: body.model,
    stream: body.stream === true,
    messageCount: (body.messages ?? []).length,
    assistantTurns: turns,
    advertisedTools: tools,
    systemChars: systemText.length,
    systemHasBrief: systemText.includes("moat sandbox"),
    systemMentionsBranch: /moat\/session-/.test(systemText),
    selectedStep: turns,
    step,
  })

  const stream = body.stream === true
  if (!stream) {
    const message = step.tool
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${turns}`,
              type: "function",
              function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) },
            },
          ],
        }
      : { role: "assistant", content: step.text ?? "" }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        id: "chatcmpl-moat",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{ index: 0, message, finish_reason: step.tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    )
    return
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  sseChunk(res, { role: "assistant", content: "" })

  if (step.tool) {
    sseChunk(res, {
      tool_calls: [
        {
          index: 0,
          id: `call_${turns}`,
          type: "function",
          function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) },
        },
      ],
    })
    sseChunk(res, {}, "tool_calls")
  } else {
    sseChunk(res, { content: step.text ?? "" })
    sseChunk(res, {}, "stop")
  }

  res.write(`data: [DONE]\n\n`)
  res.end()
})

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock-model] listening on http://127.0.0.1:${port}/v1 (${script.length} scripted steps)`)
  console.log(`[mock-model] recording requests to ${recordPath}`)
})

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
