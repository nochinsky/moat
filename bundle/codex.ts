import { CODEX_VERSION } from "../lib/pins.ts"
import { writeRootfsFile } from "../lib/rootfs-fs.ts"
import * as log from "../lib/log.ts"
import { catalogEntryForModel, reasoningLevelsFor, renderModelCatalog, type CodexCatalogModel } from "./model-catalog.ts"
import { CODEX_BUILTIN_PROMPT } from "./codex-prompt.ts"
import { describeTurn, type ToolRun, type Turn, type Usage } from "./turn.ts"

export type { CodexCatalogModel } from "./model-catalog.ts"

/**
 * The model metadata Codex reads, and the config moat renders for it.
 *
 * This file used to open with 38KB of DeepSeek's published catalog, vendored beside it and
 * installed byte-for-byte. That file was the DeepSeek lock in its most literal form: a boot
 * against any other provider got one provider's metadata, or none. The metadata is rendered
 * now (see `model-catalog.ts`), and the prompt the catalog is required to carry is a source
 * constant (see `codex-prompt.ts`).
 *
 * Two measurements belong next to this code, because both were expensive to get and one of
 * them contradicts what this comment used to say:
 *
 *  - `--effort` does **not** need the catalog. With no `model_catalog_json` at all,
 *    `model_reasoning_effort = "high"` still reaches the provider as `reasoning.effort = "high"`
 *    — measured through the recording stub. What the catalog buys is the absence of the "Model
 *    metadata for `X` not found. Defaulting to fallback metadata" advisory and the declared
 *    context/output limits, not the effort level.
 *  - the catalog changes metadata and never the prompt. `base_instructions` is the pinned
 *    binary's own text, and a request made with the catalog installed carries exactly the bytes
 *    a request without it carries — sha256 `3b08633f…`, both ways, measured by round trip.
 */
export const CATALOG_INSTRUCTIONS_SHA256 =
  "3b08633fa672906666659d764864dfda1d7af5b5111ea5817c8f46e5de4e1a8d"

/**
 * One model's catalog entry, for the model this boot is configured to use.
 *
 * The old `CODEX_CATALOG` was a frozen two-entry object read from the vendored file. This is
 * the same information for whichever model the user asked for, so nothing downstream has to
 * know which provider it is.
 */
export function catalogEntry(
  model: string,
  opts: { displayName?: string; contextWindow?: number; maxOutputTokens?: number; overrides?: Record<string, unknown> } = {},
): CodexCatalogModel {
  return catalogEntryForModel({ model, ...opts })
}

/** Every reasoning level the catalog declares across the models moat ships by default. */
export function catalogAllEffortLevels(model?: string): string[] {
  return reasoningLevelsFor(catalogEntry(model ?? "deepseek-flash"))
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
  /**
   * The provider's display name, as Codex shows it.
   *
   * This was the literal string `"DeepSeek"` until Phase 1, in the block rendered for *every*
   * provider — so a box pointed at a local endpoint told Codex, and the user reading the config,
   * that it was talking to DeepSeek. It comes from the resolved provider now.
   */
  providerLabel: string
  /** Provider base URL, e.g. `https://api.deepseek.com`. */
  baseURL: string
  /**
   * The wire API this endpoint speaks: `responses` or `chat`.
   *
   * Codex 0.155.1 ships both; the pinned provider setup used `responses` because that is what
   * DeepSeek serves. An endpoint that only speaks chat completions needs `chat`, and getting it
   * wrong is a request that fails inside the box with a parse error rather than a clear message.
   */
  wireApi?: "responses" | "chat"
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

function tomlString(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

/**
 * A token count bare in TOML, or nothing.
 *
 * These two lines are the only unquoted numbers moat writes into the config, and
 * the value comes from a fetched catalog (`lib/catalog.ts`) through
 * `resolvedModel.meta`. Interpolating it unvalidated is how a number that is not a
 * number becomes a config Codex refuses to parse: `NaN`, `Infinity`, `1e999`, a
 * negative count, a string. A bad count is not worth failing a boot over — the
 * line is optional, and Codex falls back to its own metadata — so drop it and say
 * so, rather than writing a config nobody can read.
 */
function tomlTokenCount(name: string, value: number | undefined): string[] {
  if (value === undefined) return []
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    log.warn(`ignoring an unusable ${name} from the model catalog: ${String(value)}`)
    return []
  }
  return [`${name} = ${value}`]
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
    // An API key is the only authentication moat has, for any provider, so Codex skips the
    // ChatGPT/OpenAI account paths entirely. The key itself arrives through env_key. Rendering
    // these is what keeps a provider whose key lives under its own name (the box may hold
    // ANTHROPIC_API_KEY and nothing moat named) from being sent down an account-login path.
    'preferred_auth_method = "apikey"',
    'forced_login_method = "api"',
    // The model catalog below is what tells Codex what these models can do (reasoning levels,
    // context window, tool shapes). Without it 0.155.1 prints "Model metadata for ... not found.
    // Defaulting to fallback metadata", measured; with it the notice is gone, also measured.
    `model_catalog_json = ${tomlString(CODEX_CATALOG_PATH)}`,
    // DeepSeek's Responses API accepts a web_search tool and IGNORES it (measured live: HTTP 200,
    // no web_search_call item, the model answered that it cannot search). Disabled, as their own
    // setup does, rather than advertised to the model as something that works. It stays disabled
    // for every provider: moat's box has no search service behind it, so advertising the tool
    // would only invite calls that cannot work.
    'web_search = "disabled"',
  ]
  lines.push(
    ...tomlTokenCount("model_context_window", input.contextWindow),
    ...tomlTokenCount("model_max_output_tokens", input.maxOutputTokens),
  )
  if (input.reasoningEffort) lines.push(`model_reasoning_effort = ${tomlString(input.reasoningEffort)}`)
  lines.push(
    "",
    `[model_providers.${input.providerID}]`,
    `name = ${tomlString(input.providerLabel)}`,
    `base_url = ${tomlString(input.baseURL)}`,
    ...(input.envKey ? [`env_key = ${tomlString(input.envKey)}`] : []),
    // Both wire APIs exist in 0.155.1. `responses` is what DeepSeek serves and what moat has
    // always rendered; `chat` is for an endpoint that only speaks chat completions.
    `wire_api = ${tomlString(input.wireApi ?? "responses")}`,
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
 * The model the catalog falls back to when a caller does not name one.
 *
 * Only reached by `installCodexFiles` when no catalog is passed, which happens in tests that
 * write the files without caring about the model. Every real boot passes one.
 */
const CODEX_CATALOG_DEFAULT_MODEL = "deepseek-flash"

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
 *
 * The catalog is rendered here, from the model this boot is configured to use, rather than
 * installed from a vendored file. It has to be rendered on every boot for the same reason the
 * config is: the model can change between boots, and a stale catalog would describe the previous
 * one — which is how a box ends up advertising a context window it does not have.
 */
export function installCodexFiles(
  rootfs: string,
  files: { config: string; brief: string; catalog?: string },
): void {
  const catalog = files.catalog ?? renderModelCatalog({ model: CODEX_CATALOG_DEFAULT_MODEL })
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

/**
 * The turn shape is `bundle/turn.ts`'s: one contract for every runtime, so the cost footer prices a
 * turn without knowing which agent produced it. `docs/SEAM.md` §2.3 is the argument for that.
 *
 * `CodexTurn`/`describeCodexTurn` used to be defined here, and the names are kept as aliases for the
 * call sites that are about Codex specifically.
 */
export type CodexToolRun = ToolRun
export type CodexUsage = Usage
export type CodexTurn = Turn
export const describeCodexTurn = describeTurn

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
export function parseCodexEvents(text: string): Turn {
  const turn: Turn = { tools: [], messages: [], usage: null, errors: [], notices: [] }
  const byId = new Map<string, ToolRun>()
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
    const id = typeof item.id === "string" ? item.id : undefined
    const status = type === "item.started" ? "started" : "completed"
    const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined
    const kind = typeof item.type === "string" ? item.type : "item"
    const detail = detailOf(item)
    if (id !== undefined) {
      const existing = byId.get(id)
      if (existing) {
        existing.status = "completed"
        if (exitCode !== undefined) existing.exitCode = exitCode
        continue
      }
    } else {
      // An item with no id at all. Codex always sends one, so this is the parser's
      // fallback, and the fallback used to produce two rows for one tool or one row
      // for two: the synthetic id was `item-<turn.tools.length>`, the length does not
      // change between the events of a pair, and a *completion* with no id therefore
      // merged into whichever row came last — including an already-completed one, so
      // the second of two id-less items disappeared and the first inherited its exit
      // code. A completion pairs with the most recent *unfinished* row of the same
      // kind; anything else starts its own row, so nothing is ever merged into a
      // finished one.
      const pending = [...turn.tools].reverse().find((tool) => tool.status === "started" && tool.kind === kind)
      if (pending && status === "completed") {
        pending.status = "completed"
        if (exitCode !== undefined) pending.exitCode = exitCode
        continue
      }
    }
    const rowID = id ?? `item-synthetic-${turn.tools.length}`
    const row: ToolRun = {
      id: rowID,
      kind,
      detail,
      status,
      ...(exitCode !== undefined ? { exitCode } : {}),
    }
    // Only real ids go in the map. A synthetic id is a display name for a row nothing
    // can refer back to, and putting one in the map let a *real* event that happened to
    // carry that name merge into the invented row (measured: an id-less started event
    // followed by an event with id `item-synthetic-0` collapsed to one row).
    if (id !== undefined) byId.set(id, row)
    turn.tools.push(row)
  }
  return turn
}

/** A one-line summary, for the footer. */

