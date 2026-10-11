import { writeRootfsFile } from "../lib/rootfs-fs.ts"
import { shellQuote } from "../lib/shell.ts"
import type { ModelFacts } from "../lib/model-facts.ts"
import { SANDBOX_WORKDIR } from "../lib/pins.ts"
import { describeTurn, type ToolRun, type Turn, type Usage } from "./turn.ts"

/** Pi and every extension run here, inside the box. Nothing loads host ~/.pi. */
export const PI_AGENT_DIR = "/root/.pi/agent"
export const PI_BRIEF_PATH = `${PI_AGENT_DIR}/AGENTS.md`
export const PI_SETTINGS_PATH = `${PI_AGENT_DIR}/settings.json`
export const PI_MODELS_PATH = `${PI_AGENT_DIR}/models.json`
export const PI_AUTH_EXTENSION_PATH = "/.moat/pi-auth.mjs"

// Pi requires an API-key placeholder for an unauthenticated compatible endpoint. Its
// authHeader=false does not suppress the OpenAI SDK's own Bearer header: the headers hook does.
export const PI_AUTH_EXTENSION = `export default function (pi) {
  pi.on("before_provider_headers", (event, ctx) => {
    if (!process.env.MOAT_INJECTED_CREDENTIAL && ctx.model?.provider === process.env.MOAT_MODEL?.split("/")[0]) {
      event.headers.Authorization = null
    }
  })
}
`

const LITERAL_KEY = /sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export function piThinkingLevel(effort: string): string {
  const level = effort === "none" ? "off" : effort
  if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`Pi cannot represent reasoning effort "${effort}"; use ${THINKING_LEVELS.join(", ")}`)
  }
  return level
}

export type PiConfigInput = {
  facts: ModelFacts
  providerID: string
  baseURL: string
  wireApi?: "responses" | "chat"
  /** A variable name, never a credential value. */
  envKey?: string
  reasoningEffort?: string
}

/** One explicitly configured provider/model. Pi's own catalogs never choose the endpoint. */
export function renderPiFiles(input: PiConfigInput): { config: string; catalog: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(input.providerID)) throw new Error(`invalid pi provider id: ${input.providerID}`)
  if (input.envKey && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.envKey)) throw new Error("invalid credential variable name")
  const facts = input.facts
  const effort = piThinkingLevel(input.reasoningEffort ?? facts.defaultEffort)
  const levels = facts.effortLevels.map(piThinkingLevel)
  const thinkingLevelMap = Object.fromEntries(THINKING_LEVELS.map((level) => [
    level, levels.includes(level) ? (level === "off" ? "none" : level) : null,
  ]))
  const count = (value: number | undefined) => Number.isSafeInteger(value) && value! > 0 ? value : undefined
  const model = {
    id: facts.id,
    name: facts.displayName,
    reasoning: facts.catalog?.reasoning !== false,
    input: facts.catalog?.attachment ? ["text", "image"] : ["text"],
    contextWindow: count(facts.contextWindow),
    maxTokens: count(facts.maxOutputTokens),
    thinkingLevelMap,
  }
  return {
    config: JSON.stringify({
      defaultProvider: input.providerID,
      defaultModel: facts.id,
      defaultThinkingLevel: effort,
      enabledModels: [`${input.providerID}/${facts.id}`],
      defaultProjectTrust: "always",
      cacheWarming: "off",
      enableInstallTelemetry: false,
    }, null, 2) + "\n",
    catalog: JSON.stringify({ providers: { [input.providerID]: {
      baseUrl: input.baseURL,
      api: input.wireApi === "chat" ? "openai-completions" : "openai-responses",
      apiKey: input.envKey ? `$${input.envKey}` : "moat-keyless",
      authHeader: Boolean(input.envKey),
      models: [model],
    } } }, null, 2) + "\n",
  }
}

/** Validate the whole set before writing any of it; every write uses the rootfs guard. */
export function installPiFiles(rootfs: string, files: { config: string; catalog: string; brief: string }): void {
  for (const [name, text] of Object.entries(files)) {
    if (LITERAL_KEY.test(text)) throw new Error(`refusing to write ${name} into the sandbox: it appears to contain a literal API key`)
  }
  writeRootfsFile(rootfs, PI_SETTINGS_PATH, files.config, 0o600)
  writeRootfsFile(rootfs, PI_MODELS_PATH, files.catalog, 0o600)
  writeRootfsFile(rootfs, PI_BRIEF_PATH, files.brief, 0o600)
  writeRootfsFile(rootfs, PI_AUTH_EXTENSION_PATH, PI_AUTH_EXTENSION, 0o600)
}

function piBody(args: string): string {
  return `#!/bin/sh
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
export PI_CODING_AGENT_DIR=${PI_AGENT_DIR}
export PI_OFFLINE=1
export PI_TELEMETRY=0
cd ${SANDBOX_WORKDIR}
exec pi --approve --offline --extension ${PI_AUTH_EXTENSION_PATH} --model "$MOAT_MODEL" --thinking "$MOAT_REASONING_EFFORT" ${args}
`
}

/** LF-framed JSON events, not a host-side SDK. Project extensions execute inside the box. */
export function piExecBody(prompt: string): string {
  return piBody(`--mode json -- ${shellQuote(prompt)} </dev/null`)
}

export function piTuiBody(prompt?: string): string {
  return piBody(prompt ? `-- ${shellQuote(prompt)}` : "")
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}
function normalizedUsage(value: unknown): Usage {
  const usage = record(value)
  const output = number(usage.output)
  const reasoning = Math.min(output, number(usage.reasoning))
  return {
    // Pi reports misses separately from cache hits. Cache creation is counted as input here.
    input: number(usage.input) + number(usage.cacheWrite),
    cached: number(usage.cacheRead),
    output: output - reasoning,
    reasoning,
  }
}
function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, reasoning: a.reasoning + b.reasoning }
}
function detailOf(args: unknown, name: string): string {
  const input = record(args)
  for (const key of ["command", "path", "file", "query", "url", "pattern", "prompt"]) {
    if (typeof input[key] === "string") return input[key]
  }
  return name
}

const MAX_PI_EVENT = 16 * 1024 * 1024
const MAX_REPORT_TEXT = 4 * 1024 * 1024

/** One incremental normalizer for both budgets and the footer, independent of raw-log truncation. */
export function createPiEventParser() {
  const turn: Turn = { tools: [], messages: [], usage: null, errors: [], notices: [] }
  const tools = new Map<string, ToolRun>()
  let total: Usage = { input: 0, cached: 0, output: 0, reasoning: 0 }
  let pending: Usage | null = null
  let sawUsage = false
  let terminalError: string | null = null
  let buffer = ""
  let discarding = false
  let problem: string | null = null
  let retained = 0
  const models = new Set<string>()
  const truncated = () => {
    if (turn.notices.length === 0) turn.notices.push("Pi report text/rows truncated by the host; usage accounting continues")
  }
  const retain = (value: string): string => {
    const kept = value.slice(0, Math.max(0, MAX_REPORT_TEXT - retained))
    retained += kept.length
    if (kept.length !== value.length) truncated()
    return kept
  }
  const observeModel = (message: Record<string, unknown>) => {
    if (typeof message.model !== "string") return
    const model = typeof message.provider === "string" ? `${message.provider}/${message.model}` : message.model
    if (models.size < 128) models.add(model.slice(0, 512))
    else models.add("[additional models]")
  }
  const consume = (line: string) => {
    let event: Record<string, unknown>
    try { event = record(JSON.parse(line)) } catch { return }
    if (event.type === "message_start" && record(event.message).role === "assistant") {
      pending = null
      observeModel(record(event.message))
    }
    if (event.type === "message_update" && event.usage) pending = normalizedUsage(event.usage)
    if (event.type === "message_end") {
      const message = record(event.message)
      if (message.role === "assistant") {
        pending = null
        observeModel(message)
        if (message.usage) { total = addUsage(total, normalizedUsage(message.usage)); sawUsage = true }
        terminalError = message.stopReason === "error" || message.stopReason === "aborted"
          ? String(message.errorMessage ?? `Pi response ${message.stopReason}`).slice(0, 8192) : null
        for (const block of Array.isArray(message.content) ? message.content : []) {
          const item = record(block)
          if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
            if (turn.messages.length < 2048) turn.messages.push(retain(item.text))
            else truncated()
          }
        }
      } else if (message.role === "toolResult" && message.usage) {
        total = addUsage(total, normalizedUsage(message.usage)); sawUsage = true
      }
    }
    if (event.type === "compaction_end" && record(event.result).usage) {
      total = addUsage(total, normalizedUsage(record(event.result).usage)); sawUsage = true
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      const id = typeof event.toolCallId === "string" ? event.toolCallId.slice(0, 512) : `tool-${turn.tools.length}`
      const name = typeof event.toolName === "string" ? event.toolName.slice(0, 512) : "tool"
      let row = tools.get(id)
      if (!row) {
        if (tools.size >= 2048) { truncated(); return }
        row = { id, kind: name, detail: retain(detailOf(event.args, name)), status: "started" }
        tools.set(id, row); turn.tools.push(row)
      }
      if (event.type === "tool_execution_end") {
        row.status = "completed"
        row.exitCode = event.isError === true ? 1 : 0
        row.output = retain((Array.isArray(record(event.result).content) ? record(event.result).content as unknown[] : [])
          .map((block) => record(block).type === "text" ? String(record(block).text ?? "") : "").filter(Boolean).join("\n"))
      }
    }
    if (event.type === "extension_error") {
      if (turn.errors.length < 256) turn.errors.push(retain(String(event.error ?? "Pi extension failed")))
      else truncated()
    }
    if (event.type === "agent_settled" && event.aborted === true) terminalError ??= "Pi run was aborted"
  }
  const snapshot = (): Turn => ({
    ...turn,
    errors: [...turn.errors, ...(terminalError ? [terminalError] : []), ...(problem ? [problem] : [])],
    usage: sawUsage || pending ? pending ? addUsage(total, pending) : { ...total } : null,
    models: [...models],
  })
  return {
    feed(chunk: string) {
      // LF alone frames JSONL; Unicode line separators are valid message content.
      for (const [index, piece] of chunk.split("\n").entries()) {
        if (index > 0) {
          if (!discarding) consume(buffer)
          buffer = ""; discarding = false
        }
        if (discarding) continue
        if (buffer.length + piece.length > MAX_PI_EVENT) {
          buffer = ""; discarding = true
          problem = "Pi event exceeded the host parsing limit; report/usage may be incomplete"
        } else buffer += piece
      }
    },
    snapshot,
    problem: () => problem,
    finish(): Turn { if (!discarding && buffer) consume(buffer); buffer = ""; return snapshot() },
  }
}

/** Parse authoritative messages once; never sum deltas or agent_end snapshots twice. */
export function parsePiEvents(text: string): Turn {
  const parser = createPiEventParser()
  parser.feed(text)
  return parser.finish()
}

export const describePiTurn = describeTurn
