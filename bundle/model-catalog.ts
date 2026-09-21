import { CODEX_BUILTIN_PROMPT } from "./codex-prompt.ts"

/**
 * The model metadata Codex reads, rendered instead of vendored.
 *
 * The runtime takes a `model_catalog_json` file describing each model it is allowed to
 * use: context window, output limit, which reasoning levels exist, which tools apply.
 * Without it the binary emits an advisory on every request ("Model metadata for `X` not
 * found. Defaulting to fallback metadata") and declares no limits.
 *
 * That file used to be `bundle/deepseek-models.json`: 38KB of DeepSeek's published
 * metadata, with `base_instructions` filled from the pinned binary's own prompt. It was
 * one provider's description, so a boot against any other provider got either the wrong
 * metadata or none — the DeepSeek lock in its most literal form. It is now built from
 * what the user configured.
 *
 * The shape here was measured against the pinned 0.155.1 binary rather than inferred:
 *
 *  - the parser names each field it needs, in order, and refuses the file without it. The
 *    ten `REQUIRED_*` fields below are exactly that set, discovered by adding whichever
 *    one the error named and re-running until the binary accepted the file.
 *  - `base_instructions` (or `model_messages.instructions_template`) is required on top of
 *    those; the binary exits 1 with neither. See `codex-prompt.ts`.
 *  - the remaining fields are DeepSeek's published values, kept because they are
 *    behavioural: `apply_patch_tool_type` and `shell_type` decide which tools the agent
 *    is offered and how they work, `input_modalities` and the search flags decide what
 *    Codex advertises, and changing any of them silently changes the agent's capabilities
 *    rather than its metadata. A provider that needs different values can override them;
 *    the defaults are what moat shipped before this file existed.
 *
 * MAINTAINER TRAP, and the recipe the prompt pin refers to. A Codex version bump can move
 * the built-in prompt and can add required fields. To re-check both against the new
 * binary, with the recording stub from `stub/mock-responses.mjs`:
 *
 *   # 1. what the new binary sends for a model it has no metadata for
 *   $ CODEX_HOME=<dir> codex exec --json --skip-git-repo-check "say hi"
 *   $ python3 -c 'import hashlib,json;print(hashlib.sha256(json.load(open("<record>"))["instructions"].encode()).hexdigest())'
 *
 *   # 2. the fields it now requires, and its own resolved view of the same model
 *   $ CODEX_HOME=<dir> codex debug models
 *
 * Step 2 is the useful half: `codex debug models` prints the binary's fully-resolved
 * catalog entry as JSON, which is where the field values and the required set come from.
 * A file the parser rejects names the missing field, so the set is recoverable by
 * iterating. `test/unit/model-catalog.test.ts` pins the result.
 */

/** One model's metadata, as Codex reads it. Extra keys are allowed and passed through. */
export type CodexCatalogModel = {
  slug: string
  display_name: string
  supported_reasoning_levels: { effort: string; description: string }[]
  shell_type: string
  visibility: string
  supported_in_api: boolean
  priority: number
  support_verbosity: boolean
  truncation_policy: { mode: string; limit: number }
  experimental_supported_tools: string[]
  base_instructions: string
  default_reasoning_level?: string
  context_window?: number
  max_output_tokens?: number
} & Record<string, unknown>

export type CodexCatalog = { models: CodexCatalogModel[] }

/**
 * Values that are the same for every model unless a provider says otherwise.
 *
 * These are DeepSeek's published settings, which is what moat has always run. They are
 * behavioural, not cosmetic: `shell_type` and `apply_patch_tool_type` choose the tool
 * surface the agent gets.
 */
const MODEL_DEFAULTS = {
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 1,
  support_verbosity: true,
  truncation_policy: { mode: "tokens", limit: 10_000 },
  experimental_supported_tools: [] as string[],
  prefer_websockets: false,
  default_verbosity: "low",
  apply_patch_tool_type: "freeform",
  web_search_tool_type: "text",
  input_modalities: ["text", "image"],
  supports_image_detail_original: true,
  supports_parallel_tool_calls: true,
  tool_mode: null,
  multi_agent_version: "v2",
  use_responses_lite: false,
  include_skills_usage_instructions: false,
  auto_review_model_override: null,
  effective_context_window_percent: 95,
  auto_compact_token_limit: null,
  comp_hash: "3000",
  reasoning_summary_format: "experimental",
  default_reasoning_summary: "none",
  supports_reasoning_summaries: true,
  supports_search_tool: true,
  default_service_tier: null,
  availability_nux: null,
  upgrade: null,
  minimal_client_version: "0.144.0",
} as const

/**
 * The reasoning levels moat offers when a provider does not say.
 *
 * DeepSeek's, which is what `--effort` has always been validated against. A provider with
 * a different ladder overrides this rather than getting a list it does not implement.
 */
export const DEFAULT_REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "high", description: "Extra high reasoning depth for complex problems" },
  { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
] as const

/** The level the runtime picks when the user does not pass `--effort`. */
export const DEFAULT_REASONING_LEVEL = "high"

export type ModelMetadataInput = {
  /** The model id as the provider knows it. Becomes the catalog `slug`. */
  model: string
  /** Label Codex shows. Defaults to the id itself, which is honest for an unknown model. */
  displayName?: string
  /** Declared context window, when the user configured one. */
  contextWindow?: number
  maxOutputTokens?: number
  /** The levels this model implements. Defaults to `DEFAULT_REASONING_LEVELS`. */
  reasoningLevels?: { effort: string; description: string }[]
  defaultReasoningLevel?: string
  /** Provider-specific overrides, merged over `MODEL_DEFAULTS`. */
  overrides?: Record<string, unknown>
}

/**
 * One catalog entry for a model, with every field the parser requires.
 *
 * A token count that is not a positive safe integer is dropped rather than written: the
 * counts can come from a fetched catalog, and `model_context_window = NaN` is a config
 * Codex refuses to parse. The same rule the rendered TOML follows.
 */
export function catalogEntryForModel(input: ModelMetadataInput): CodexCatalogModel {
  const entry: CodexCatalogModel = {
    ...MODEL_DEFAULTS,
    ...input.overrides,
    slug: input.model,
    display_name: input.displayName ?? input.model,
    supported_reasoning_levels: [...(input.reasoningLevels ?? DEFAULT_REASONING_LEVELS)],
    default_reasoning_level: input.defaultReasoningLevel ?? DEFAULT_REASONING_LEVEL,
    base_instructions: CODEX_BUILTIN_PROMPT,
  }
  const context = positiveInt(input.contextWindow)
  const output = positiveInt(input.maxOutputTokens)
  if (context !== undefined) {
    entry.context_window = context
    entry.max_context_window = context
  }
  if (output !== undefined) entry.max_output_tokens = output
  return entry
}

/** A token count, or nothing. See `renderCodexConfig` for why this is not a cast. */
function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined
  return value
}

/** The whole catalog file for one model, as Codex reads it. */
export function renderModelCatalog(input: ModelMetadataInput): string {
  const catalog: CodexCatalog = { models: [catalogEntryForModel(input)] }
  return `${JSON.stringify(catalog, null, 2)}\n`
}

/** Every reasoning level the entry for this model declares. */
export function reasoningLevelsFor(entry: CodexCatalogModel): string[] {
  return (entry.supported_reasoning_levels ?? []).map((level) => level.effort)
}
