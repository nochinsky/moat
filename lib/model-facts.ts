import * as log from "./log.ts"
import { catalogModel, formatTokens, type Catalog, type CatalogModel } from "./catalog.ts"
import type { CatalogPrice } from "./pricing.ts"

const DEFAULT_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

/** Describe one configured model once; Pi config, effort checks and reporting share these facts. */
export type ModelFacts = {
  id: string
  providerID: string
  /** Never price another provider's same-named model with DeepSeek's local table. */
  pricingID: string
  label: string
  displayName: string
  contextWindow?: number
  maxOutputTokens?: number
  native: boolean
  effortLevels: string[]
  defaultEffort: string
  catalog?: CatalogModel
}

export type ResolveModelFactsInput = {
  catalog: Catalog | null
  providerID: string
  modelID: string
  providerIsNative: boolean
  effortLevels?: readonly string[]
  defaultEffort?: string
}

export function resolveModelFacts(input: ResolveModelFactsInput): ModelFacts {
  const { catalog, providerID, modelID } = input
  const known = catalogModel(catalog, providerID, modelID)
  const providerEntry = catalog?.get(providerID)
  if (catalog && input.providerIsNative && providerEntry && !known) {
    log.warn(`${providerID} does not define "${modelID}" in the models.dev catalog; proceeding with that id. Known ids: ${providerEntry.models.map((m) => m.id).join(", ")}   (moat models)`)
  }
  if (known && known.toolCall === false) {
    log.warn(`${providerID}/${modelID} does not advertise tool calling; the agent will not be able to act.`)
  }
  const levels = [...(input.effortLevels ?? (known?.reasoning === false ? ["none"] : DEFAULT_EFFORT_LEVELS))]
  return {
    id: modelID,
    providerID,
    pricingID: providerID === "deepseek" ? modelID : `${providerID}/${modelID}`,
    label: `${providerID}/${modelID}`,
    displayName: known?.name ?? modelID,
    contextWindow: known?.context,
    maxOutputTokens: known?.output,
    native: input.providerIsNative,
    effortLevels: levels.length ? levels : [...DEFAULT_EFFORT_LEVELS],
    defaultEffort: known?.reasoning === false ? "none" : input.defaultEffort ?? "high",
    ...(known ? { catalog: known } : {}),
  }
}

export function describeModelFacts(facts: ModelFacts): string {
  const limits = facts.contextWindow === undefined ? "" : ` (context ${formatTokens(facts.contextWindow)}${facts.maxOutputTokens ? `, out ${formatTokens(facts.maxOutputTokens)}` : ""})`
  return `model: ${facts.label}${limits}`
}

export function defaultEffortLevels(): string[] {
  return [...DEFAULT_EFFORT_LEVELS]
}

export function checkEffort(level: string, levels: readonly string[]): string | null {
  if (levels.includes(level)) return null
  return `unknown --effort "${level}". This model declares: ${levels.join(", ")}\n  (the ladder is moat's own per provider: models.dev describes whether a model reasons, not which levels it implements)`
}

/** Provider-scoped prices, never a model-only lookup. DeepSeek uses the checked local table. */
export function catalogPriceForFacts(facts: ModelFacts, catalog: Catalog | null): CatalogPrice | undefined {
  if (facts.providerID === "deepseek") return undefined
  const model = catalogModel(catalog, facts.providerID, facts.id)
  if (!model?.cost) return undefined
  return {
    input: model.cost.input,
    output: model.cost.output,
    ...(model.cost.cacheRead !== undefined ? { cacheRead: model.cost.cacheRead } : {}),
  }
}
