import fs from "node:fs"
import { fileURLToPath } from "node:url"

import { CODEX_VERSION } from "../lib/pins.ts"
import { writeRootfsFile } from "../lib/rootfs-fs.ts"

/**
 * The DeepSeek model catalog Codex reads, vendored from DeepSeek's documented Codex setup.
 *
 * Source: https://api-docs.deepseek.com/quick_start/agent_integrations/codex — their `models.json`,
 * the file their setup script writes to `~/.codex/models.json`. It is what turns a model Codex has
 * no metadata for into one it treats like a built-in: context window, reasoning-effort levels, the
 * patch-tool type, parallel tool calls, the multi-agent version. Without it Codex prints "Model
 * metadata for `<id>` not found" and sends **no** `reasoning.effort` at all — measured through
 * test/mock-responses.mjs, and the reason `--effort` had to be removed before this file existed.
 *
 * Dropped from DeepSeek's copy, deliberately:
 *
 *  - `model_messages` — its `instructions_template` is the same ~18 KB prompt as
 *    `base_instructions`; Codex accepts either.
 *  - `base_instructions` **as DeepSeek ships it** — their text ("You are Codex, an agent based on
 *    GPT-5…") is OpenAI's Codex CLI system prompt vendored at their snapshot, so shipping it would
 *    freeze the agent's instructions at DeepSeek's copy of someone else's prompt and silently stop
 *    every upstream Codex improvement to tool descriptions and safety rules from applying.
 *
 * The field itself cannot be deleted, and that was measured rather than assumed. With
 * `base_instructions` removed from both entries, the pinned 0.155.1 binary refuses the catalog at
 * startup and exits 1:
 *
 *   $ CODEX_HOME=<dir> codex exec --json --skip-git-repo-check "say hi"
 *   Error: failed to parse model_catalog_json path `<dir>/models.json` as JSON: model
 *   `deepseek-flash` is missing both `base_instructions` and `model_messages.instructions_template`
 *   at line 119 column 1
 *
 * Codex requires one of the two fields, so a strictly metadata-only catalog is not expressible
 * without a fork. The field stays; what fills it does not have to be DeepSeek's text.
 *
 * It is the prompt our own pinned binary sends for a model it has no metadata for, captured from
 * that binary through the recording stub. With the catalog installed, Codex sends exactly this
 * text as the request's top-level `instructions`, and it is byte-identical to the no-catalog
 * request (sha256 below, the same text for both entries), so adopting the catalog changes metadata
 * only — never the prompt. Shipping DeepSeek's text instead would change it: measured, the
 * provider then receives their prompt. The sha is pinned and `test/unit/codex-runtime.test.ts`
 * checks the vendored file against it, so a Codex upgrade that moves the built-in prompt fails a
 * test rather than silently serving a stale one.
 *
 * MAINTAINER TRAP: a Codex version bump can move this built-in prompt, and the pin has to be
 * refreshed in the same commit or the agent keeps running the old prompt while the binary moves.
 * To re-capture, run the new binary against the recording stub with a config that has NO
 * `model_catalog_json`, then sha256 the `instructions` field of the request it sent:
 *
 *   $ CODEX_HOME=<dir> DEEPSEEK_API_KEY=… codex exec --json --skip-git-repo-check "say hi"
 *   $ python3 -c 'import hashlib,json;print(hashlib.sha256(json.load(open("<record>"))["instructions"].encode()).hexdigest())'
 *   3b08633fa672906666659d764864dfda1d7af5b5111ea5817c8f46e5de4e1a8d
 *
 * and copy that `instructions` text into both entries' `base_instructions` (measured: the same
 * text for both). To use DeepSeek's tuning instead, replace `base_instructions` with their text
 * (or add `model_messages.instructions_template`) and re-record the sha.
 */
export const CATALOG_SOURCE_URL = "https://api-docs.deepseek.com/quick_start/agent_integrations/codex"
export const CATALOG_INSTRUCTIONS_SHA256 =
  "3b08633fa672906666659d764864dfda1d7af5b5111ea5817c8f46e5de4e1a8d"

export type CodexCatalogModel = {
  slug: string
  display_name: string
  default_reasoning_level: string
  supported_reasoning_levels: { effort: string; description: string }[]
  base_instructions: string
} & Record<string, unknown>

export type CodexCatalog = { models: CodexCatalogModel[] }

/**
 * The vendored catalog, read once: it ships beside this file and never changes at runtime. The raw
 * text is kept too, and installed byte-for-byte, so what the box reads is the file in this
 * repository rather than a re-serialization of it.
 */
const VENDORED_CATALOG = fs.readFileSync(fileURLToPath(new URL("./deepseek-models.json", import.meta.url)), "utf8")
export const CODEX_CATALOG: CodexCatalog = JSON.parse(VENDORED_CATALOG) as CodexCatalog

/** The catalog entry for a model, or null when moat has no metadata for it. */
export function catalogModel(model: string): CodexCatalogModel | null {
  return CODEX_CATALOG.models.find((entry) => entry.slug === model) ?? null
}

/** The reasoning levels the catalog declares for a model. Empty when it is not listed. */
export function catalogEffortLevels(model: string): string[] {
  return catalogModel(model)?.supported_reasoning_levels.map((level) => level.effort) ?? []
}

/** The level Codex would use on its own for this model, from the catalog. */
export function catalogDefaultEffort(model: string): string | null {
  return catalogModel(model)?.default_reasoning_level ?? null
}

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
 *    Measured; see `docs/HISTORY.md`.
 */

export type CodexConfigInput = {
  /** Model id inside the provider, e.g. `deepseek-v4-pro`. */
  model: string
  /** Provider id. Becomes the `[model_providers.<id>]` key, so it is validated. */
  providerID: string
  /** Provider base URL, e.g. `https://api.deepseek.com`. */
  baseURL: string
  /**
   * Environment variable carrying the key *inside the box*. Never the value.
   *
   * Omitted for a custom endpoint booted with `--no-credential`: there is no key to read, and
   * pointing Codex at a name nothing sets is a failure waiting to happen rather than a
   * configuration.
   */
  envKey?: string
  /** Context window to declare, so the first run is not a metadata guess. */
  contextWindow?: number
  maxOutputTokens?: number
  /**
   * `model_reasoning_effort`, when the user asked for one.
   *
   * The levels are DeepSeek's, not OpenAI's: the vendored catalog declares `low`, `high` and
   * `max` for both models, and `--effort` is validated against them before provisioning. This
   * line is what decides the wire. Measured through the recording stub with the catalog installed:
   * `high` sends `reasoning.effort = "high"` and `low` sends `"low"`, regardless of the catalog
   * entry's `default_reasoning_level` (which is left alone); a model with no catalog entry gets
   * the same key plus the metadata notice. Rendering the chosen level into the catalog instead
   * does nothing — the config line wins.
   */
  reasoningEffort?: string
}

/** Every reasoning level the vendored catalog declares, from the catalog rather than a list here. */
export function catalogAllEffortLevels(): string[] {
  const levels = new Set<string>()
  for (const model of CODEX_CATALOG.models) {
    for (const level of model.supported_reasoning_levels ?? []) levels.add(level.effort)
  }
  return [...levels].sort()
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
    // DeepSeek's documented setup: an API key is the only authentication, so Codex skips the
    // ChatGPT/OpenAI account paths entirely. The key itself still arrives through env_key.
    'preferred_auth_method = "apikey"',
    'forced_login_method = "api"',
    // The model catalog below is what tells Codex what these models can do (reasoning levels,
    // context window, tool shapes). Without it 0.155.1 prints "Model metadata for ... not found.
    // Defaulting to fallback metadata", measured; with it the notice is gone, also measured.
    `model_catalog_json = ${tomlString(CODEX_CATALOG_PATH)}`,
    // DeepSeek's Responses API accepts a web_search tool and IGNORES it (measured live: HTTP 200,
    // no web_search_call item, the model answered that it cannot search). Disabled, as their own
    // setup does, rather than advertised to the model as something that works.
    'web_search = "disabled"',
  ]
  if (input.contextWindow) lines.push(`model_context_window = ${input.contextWindow}`)
  if (input.maxOutputTokens) lines.push(`model_max_output_tokens = ${input.maxOutputTokens}`)
  if (input.reasoningEffort) lines.push(`model_reasoning_effort = ${tomlString(input.reasoningEffort)}`)
  lines.push(
    "",
    `[model_providers.${input.providerID}]`,
    'name = "DeepSeek"',
    `base_url = ${tomlString(input.baseURL)}`,
    ...(input.envKey ? [`env_key = ${tomlString(input.envKey)}`] : []),
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

/** Where the brief lives, beside the config: Codex reads `$CODEX_HOME/AGENTS.md`. */
export function codexBriefPath(home = "/root"): string {
  return `${home}/.codex/AGENTS.md`
}

/** The model catalog Codex reads, as DeepSeek's setup writes it. Rendered on every boot. */
export const CODEX_CATALOG_PATH = "/root/.codex/models.json"

/**
 * Fail loudly if a literal secret is about to be written into the sandbox.
 *
 * Every artefact moat writes into the box is checked, and the patterns cover the common key
 * shapes rather than only DeepSeek's: the old `/sk-[A-Za-z0-9]{16,}/` did not match
 * `sk-proj-...` or `sk-ant-api03-...` at all, because the hyphen ended the run.
 */
const LITERAL_KEY = new RegExp(
  [
    "sk-[A-Za-z0-9_-]{16,}", // OpenAI, Anthropic, DeepSeek
    "AIza[0-9A-Za-z_-]{20,}", // Google
    "AKIA[0-9A-Z]{16}", // AWS access key id
    "gh[pousr]_[A-Za-z0-9]{20,}", // GitHub
    "hf_[A-Za-z0-9]{20,}", // Hugging Face
    "xox[baprs]-[A-Za-z0-9-]{10,}", // Slack
    "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  ].join("|"),
)

/**
 * Write the three files that decide how the agent behaves, through the rootfs guard.
 *
 * This runs on EVERY boot, not only when the image is provisioned: the rootfs may come from
 * the host image cache or from an environment created days ago, and all three files are policy.
 * A stale one silently running an old policy is a bug that already happened once with the
 * opencode bundle.
 *
 * The credential reaches the box as an environment variable and never as a file, so anything
 * that looks like a key in any of the three texts is refused rather than written: that is what
 * makes "grep the image for the key and find nothing" checkable.
 */
export function installCodexFiles(rootfs: string, files: { config: string; brief: string }): void {
  const catalog = VENDORED_CATALOG
  for (const [name, text] of [
    ["config.toml", files.config],
    ["AGENTS.md", files.brief],
    ["models.json", catalog],
  ] as const) {
    if (LITERAL_KEY.test(text)) {
      throw new Error(`refusing to write ${name} into the sandbox: it appears to contain a literal API key`)
    }
  }
  // Through lib/rootfs-fs.ts, never a plain write: the agent is root in its box and can plant
  // a symlink where a directory used to be, and this runs on every boot. Measured before the
  // guard existed: an AGENTS.md of 3834 bytes landed outside the rootfs, every boot.
  writeRootfsFile(rootfs, codexConfigPath(), files.config, 0o600)
  writeRootfsFile(rootfs, codexBriefPath(), files.brief, 0o600)
  writeRootfsFile(rootfs, CODEX_CATALOG_PATH, catalog, 0o600)
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
      // against the identical task on both runtimes: `docs/HISTORY.md`.
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
