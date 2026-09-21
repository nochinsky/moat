import * as log from "./log.ts"
import { catalogModel, formatTokens, type Catalog, type CatalogModel } from "./catalog.ts"
import {
  DEFAULT_REASONING_LEVEL,
  DEFAULT_REASONING_LEVELS,
  renderModelCatalog,
  type CodexCatalogModel,
} from "../bundle/model-catalog.ts"

/**
 * What moat knows about the model a boot is configured to use.
 *
 * This exists because the same model was being described twice, by two modules that did not
 * agree, and the disagreement was visible rather than theoretical:
 *
 *   - `lib/catalog.ts` (models.dev, fetched, 222 providers) said the default model's name is
 *     `DeepSeek V4.1 Flash`, its context is 1000000 and its output cap 384000.
 *   - `bundle/model-catalog.ts` (rendered per boot, handed to Codex) said the display name was
 *     `deepseek-flash` — the raw id — because the caller had nothing else to pass it.
 *
 * One boot, two names for one model. The fix is not to pick a winner between the two files but
 * to resolve the facts **once**, in one place, and let every consumer read that record: the
 * rendered TOML (`renderCodexConfig`), the catalog Codex parses, the task report, the
 * `moat models` listing and the `--effort` validation all describe the same model, so they
 * cannot drift apart.
 *
 * The sources, and why both are needed:
 *
 *  - **models.dev** is the host's broad picture: which providers exist, which model ids they
 *    define, and each model's context window, output cap, name and capabilities. It is fetched
 *    and cached and optional.
 *  - **moat's own ladder** is the one thing models.dev does not describe: which reasoning
 *    levels a model implements. models.dev carries a `reasoning: true/false` flag and nothing
 *    finer, so the level list is moat's, per provider if the provider declares one.
 *  - **the model id itself** is always a fact, even when nothing else is known.
 *
 * A model neither source describes is not an error, and it is not silence either: the boot
 * proceeds with the model's own id as its label and no declared limits, and says so. That is
 * the `--base-url` case — a local endpoint with a model nobody has published metadata for —
 * and it is how the whole test suite runs.
 */

export type ModelFacts = {
  /** The model id as the provider knows it. */
  id: string
  /** The provider id this model is used through. */
  providerID: string
  /** Provider and model, for logs and the task footer: `deepseek/deepseek-flash`. */
  label: string
  /**
   * What Codex shows and what a human reads.
   *
   * models.dev's name when it has one (`DeepSeek V4.1 Flash`), otherwise the id. Before this
   * resolution existed the rendered catalog always got the id, so a model moat could name was
   * displayed as its slug.
   */
  displayName: string
  /** Declared context window, when either source knows one. */
  contextWindow?: number
  maxOutputTokens?: number
  /** Whether this provider/model was resolved through models.dev's own definitions. */
  native: boolean
  /** The reasoning levels this model implements. Never empty. */
  effortLevels: string[]
  /** The level the runtime uses when the user passes no `--effort`. */
  defaultEffort: string
  /** models.dev's record, when it has one. For warnings about capabilities. */
  catalog?: CatalogModel
}

export type ResolveModelFactsInput = {
  catalog: Catalog | null
  providerID: string
  modelID: string
  /**
   * Whether the provider is one models.dev describes, so moat can treat an unknown model id as
   * a mistake worth naming rather than as the normal `--base-url` case.
   */
  providerIsNative: boolean
  /** The provider's own reasoning ladder, when the configured provider declares one. */
  effortLevels?: readonly string[]
  defaultEffort?: string
}

/**
 * Resolve the facts for one model, with the warnings the resolution implies.
 *
 * Warnings live here rather than at the call site so a second caller cannot skip them, and so
 * the conditions they describe are stated once, next to the decision they qualify.
 */
export function resolveModelFacts(input: ResolveModelFactsInput): ModelFacts {
  const { catalog, providerID, modelID } = input
  const known = catalogModel(catalog, providerID, modelID)
  const providerEntry = catalog?.get(providerID)

  // A provider models.dev describes, asked for a model it does not define. Usually a typo, and
  // worth saying before the boot is spent on it — but not an error: the endpoint may serve a
  // model the dataset has not caught up with, so moat proceeds and describes it honestly.
  if (catalog && input.providerIsNative && providerEntry && !known) {
    log.warn(
      `${providerID} does not define "${modelID}" in the models.dev catalog; declaring it as a custom ` +
        `model instead. Known ids: ${providerEntry.models.map((m) => m.id).join(", ")}   (moat models)`,
    )
  }
  if (known && known.toolCall === false) {
    log.warn(`${providerID}/${modelID} does not advertise tool calling; the agent will not be able to act.`)
  }

  const levels = [...(input.effortLevels ?? DEFAULT_REASONING_LEVELS.map((level) => level.effort))]
  const facts: ModelFacts = {
    id: modelID,
    providerID,
    label: `${providerID}/${modelID}`,
    displayName: known?.name ?? modelID,
    contextWindow: known?.context,
    maxOutputTokens: known?.output,
    native: input.providerIsNative,
    effortLevels: levels.length > 0 ? levels : DEFAULT_REASONING_LEVELS.map((level) => level.effort),
    defaultEffort: input.defaultEffort ?? DEFAULT_REASONING_LEVEL,
    ...(known ? { catalog: known } : {}),
  }
  return facts
}

/** One line describing the model for the boot log, with the limits that were resolved. */
export function describeModelFacts(facts: ModelFacts): string {
  const limits =
    facts.contextWindow === undefined
      ? ""
      : ` (context ${formatTokens(facts.contextWindow)}` +
        `${facts.maxOutputTokens ? `, out ${formatTokens(facts.maxOutputTokens)}` : ""})`
  return `model: ${facts.label}${limits}`
}

/**
 * The reasoning levels to offer for a model whose provider declared none.
 *
 * moat's own ladder, matching what the rendered catalog declares, so `--effort` validation and
 * the catalog cannot disagree about which levels exist. Exported so the two callers that need a
 * list without resolving a model — `--effort` validation before provisioning, and `moat models`
 * — read it from here rather than from the bundle.
 */
export function defaultEffortLevels(): string[] {
  return DEFAULT_REASONING_LEVELS.map((level) => level.effort)
}

/**
 * Validate an `--effort` value against the levels the model declares.
 *
 * Returns the message to fail with, or null. The list is the model's, not a global one: a
 * provider that implements `none`/`medium` should not be offered `max`, and a level Codex would
 * silently drop is worse than a refusal because the turn then runs at a depth nobody chose.
 */
export function checkEffort(level: string, levels: readonly string[]): string | null {
  if (levels.includes(level)) return null
  return (
    `unknown --effort "${level}". This model declares: ${levels.join(", ")}\n` +
    "  (the ladder is moat's own per provider: models.dev describes whether a model reasons, " +
    "not which levels it implements)"
  )
}

/**
 * The catalog entry Codex parses, built from the resolved facts.
 *
 * Thin on purpose: it is the one place the facts become the runtime's schema, so the values
 * Codex is handed and the values moat prints come from the same record.
 */
export function catalogEntryFromFacts(facts: ModelFacts, opts: { overrides?: Record<string, unknown> } = {}): CodexCatalogModel {
  return {
    ...opts.overrides,
    slug: facts.id,
    display_name: facts.displayName,
    supported_reasoning_levels: facts.effortLevels.map((effort) => ({
      effort,
      description: levelDescription(effort),
    })),
    default_reasoning_level: facts.defaultEffort,
    context_window: facts.contextWindow,
    max_output_tokens: facts.maxOutputTokens,
  } as CodexCatalogModel
}

/** A short human description for a reasoning level, for the catalog's own listing. */
function levelDescription(effort: string): string {
  const known = DEFAULT_REASONING_LEVELS.find((level) => level.effort === effort)
  return known?.description ?? `${effort} reasoning`
}

/**
 * The catalog file Codex parses, built from the resolved facts.
 *
 * The one place the facts become the runtime's schema, so the values Codex is handed and the
 * values moat prints come from the same record. `renderModelCatalog` fills in the fields that
 * are the same for every model (the tool surface, the truncation policy, the prompt pin) and
 * these override the per-model ones.
 */
export function renderCatalogFromFacts(facts: ModelFacts, opts: { overrides?: Record<string, unknown> } = {}): string {
  return renderModelCatalog({
    model: facts.id,
    displayName: facts.displayName,
    contextWindow: facts.contextWindow,
    maxOutputTokens: facts.maxOutputTokens,
    reasoningLevels: facts.effortLevels.map((effort) => ({ effort, description: levelDescription(effort) })),
    defaultReasoningLevel: facts.defaultEffort,
    overrides: opts.overrides,
  })
}
