import { CODEX_VERSION } from "../lib/pins.ts"

/**
 * The Codex runtime: the config moat renders for it, and the host side of `codex exec --json`.
 *
 * Codex is not driven over a server the way opencode is. It is a CLI: the box runs it, and
 * the host either attaches a terminal to its TUI or reads the JSONL event stream of
 * `codex exec`. Both shapes keep the loop, the tools and the filesystem inside the box —
 * the host is a terminal or a log reader, never a tool executor.
 *
 * Two things here are load-bearing:
 *
 *  - `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` are rendered by
 *    moat, every boot, from this file. Codex has its own approval engine and its own Linux
 *    sandbox; inside moat they would be a second, weaker boundary next to a real one, and a
 *    false sense of one. moat's box is the boundary, so Codex's is turned off — deliberately,
 *    in one place, not by whatever the agent left in `~/.codex`.
 *  - the provider is a `[model_providers.*]` block even though Codex's documentation lists
 *    DeepSeek as built in: 0.155.1 answers `Error: Model provider \`deepseek\` not found`.
 *    Measured; see docs/RUNTIME-SPIKE-codex.md.
 */

export type CodexConfigInput = {
  /** Model id inside the provider, e.g. `deepseek-v4-pro`. */
  model: string
  /** Provider id. Becomes the `[model_providers.<id>]` key, so it is validated. */
  providerID: string
  /** Provider base URL, e.g. `https://api.deepseek.com`. */
  baseURL: string
  /** Environment variable carrying the key *inside the box*. Never the value. */
  envKey: string
  /** Context window to declare, so the first run is not a metadata guess. */
  contextWindow?: number
  maxOutputTokens?: number
}

function tomlString(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

export function renderCodexConfig(input: CodexConfigInput): string {
  if (!/^[A-Za-z0-9_-]+$/.test(input.providerID)) {
    throw new Error(`invalid codex provider id: ${input.providerID}`)
  }
  const lines = [
    `model = ${tomlString(input.model)}`,
    `model_provider = ${tomlString(input.providerID)}`,
    // moat's box is the sandbox; Codex must not add a second one or ask for approvals.
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
  ]
  if (input.contextWindow) lines.push(`model_context_window = ${input.contextWindow}`)
  if (input.maxOutputTokens) lines.push(`model_max_output_tokens = ${input.maxOutputTokens}`)
  lines.push(
    "",
    `[model_providers.${input.providerID}]`,
    'name = "DeepSeek"',
    `base_url = ${tomlString(input.baseURL)}`,
    `env_key = ${tomlString(input.envKey)}`,
    // 0.155.1 supports only the Responses wire API, and that is what DeepSeek serves.
    'wire_api = "responses"',
    "",
  )
  return lines.join("\n")
}

/** The config as it is installed in the box, plus how it was produced. */
export function codexConfigPath(home = "/root"): string {
  return `${home}/.codex/config.toml`
}

export type CodexToolRun = {
  id: string
  /** `command_execution`, `file_change`, `mcp_tool_call`, `reasoning`, … */
  kind: string
  /** The command, path or query the item carries. */
  detail: string
  status: "started" | "completed"
  exitCode?: number | null
}

export type CodexUsage = {
  /** Cache-*miss* input tokens, the field opencode also calls `input`. */
  input: number
  /** Cache-hit input tokens. */
  cached: number
  output: number
  reasoning: number
}

export type CodexTurn = {
  tools: CodexToolRun[]
  messages: string[]
  usage: CodexUsage | null
  errors: string[]
  /**
   * Advisories that arrive on the same channel as errors but are not failures.
   *
   * Codex prints "Model metadata for <id> not found. Defaulting to fallback metadata" as an
   * `error` item on the first run in a fresh `~/.codex` — it is a cache miss, not a broken
   * turn, and counting it made a successful run read `1 error` in the footer (measured).
   */
  notices: string[]
}

/** The one advisory this parser knows is not a failure. */
function isNotice(message: string): boolean {
  return /^Model metadata for .* not found/.test(message)
}

function numberField(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function detailOf(item: Record<string, unknown>): string {
  for (const key of ["command", "path", "file", "filename", "query", "text"]) {
    const value = item[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return typeof item.type === "string" ? item.type : "item"
}

/**
 * One `codex exec --json` stream, in the shape the CLI prints it.
 *
 * Item events arrive as a start and a completion for the same id, so they are merged into
 * one row per tool. Unknown event types are ignored rather than guessed at: a newer Codex
 * must not make this parser invent rows.
 */
export function parseCodexEvents(text: string): CodexTurn {
  const turn: CodexTurn = { tools: [], messages: [], usage: null, errors: [], notices: [] }
  const byId = new Map<string, CodexToolRun>()
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    const type = event.type
    if (type === "turn.completed") {
      const usage = (event.usage ?? {}) as Record<string, unknown>
      const cached = numberField(usage, "cached_input_tokens")
      // `input_tokens` **includes** the cached ones — that is the Responses shape, and it is
      // not opencode's: there `input` is the cache-*miss* count and the hits are separate.
      // Charging the raw field at the miss rate and the cached field at the hit rate double
      // counts them, which over-reported a mostly-cached turn by about ten times. Measured
      // against the identical task on both runtimes: docs/RUNTIME-COST.md.
      turn.usage = {
        input: Math.max(0, numberField(usage, "input_tokens") - cached),
        cached,
        output: numberField(usage, "output_tokens"),
        reasoning: numberField(usage, "reasoning_output_tokens"),
      }
      continue
    }
    if (type === "error") {
      const message = typeof event.message === "string" ? event.message : "codex reported an error"
      if (isNotice(message)) turn.notices.push(message)
      else turn.errors.push(message)
      continue
    }
    const item = event.item as Record<string, unknown> | undefined
    if (!item) continue
    if (item.type === "agent_message") {
      const text = item.text
      if (typeof text === "string" && text.trim().length > 0) turn.messages.push(text)
      continue
    }
    if (item.type === "error") {
      const message = typeof item.message === "string" ? item.message : "codex reported an error"
      if (isNotice(message)) turn.notices.push(message)
      else turn.errors.push(message)
      continue
    }
    const id = typeof item.id === "string" ? item.id : `item-${turn.tools.length}`
    const status = type === "item.started" ? "started" : "completed"
    const existing = byId.get(id)
    const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined
    if (existing) {
      existing.status = "completed"
      if (exitCode !== undefined) existing.exitCode = exitCode
      continue
    }
    const row: CodexToolRun = {
      id,
      kind: typeof item.type === "string" ? item.type : "item",
      detail: detailOf(item),
      status,
      ...(exitCode !== undefined ? { exitCode } : {}),
    }
    byId.set(id, row)
    turn.tools.push(row)
  }
  return turn
}

/** A one-line summary, for the footer. */
export function describeCodexTurn(turn: CodexTurn): string {
  const failed = turn.tools.filter((tool) => tool.status === "completed" && (tool.exitCode ?? 0) !== 0).length
  const parts = [
    turn.tools.length === 1 ? "1 tool" : `${turn.tools.length} tools`,
  ]
  if (failed > 0) parts.push(`${failed} failed`)
  if (turn.errors.length > 0) parts.push(turn.errors.length === 1 ? "1 error" : `${turn.errors.length} errors`)
  return parts.join(" · ")
}

export const CODEX_RUNTIME_VERSION = CODEX_VERSION
