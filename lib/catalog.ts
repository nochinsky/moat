import fs from "node:fs"
import path from "node:path"

import { cacheDir } from "./paths.ts"
import * as log from "./log.ts"

/**
 * The models.dev catalog, cached on the host.
 *
 * It is the dataset the runtime ecosystem is built on, so moat can use it for three things
 * without guessing:
 *
 *  1. deciding whether a provider is *native* (models.dev describes it, so moat
 *     writes no provider block and inherits accurate context/output limits and
 *     tool-call support), or whether moat must declare it explicitly;
 *  2. `moat models`, showing what is actually available, with context windows,
 *     instead of a hardcoded list that goes stale;
 *  3. refusing a model id that the provider does not define, before spending a
 *     boot on a typo.
 *
 * The catalog is refreshed at most once a day and is entirely optional: if the
 * network is unavailable, moat falls back to its own provider table and says so.
 */

export const CATALOG_URL = "https://models.dev/api.json"
const MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * What the catalog says a model costs, in USD per 1M tokens.
 *
 * Used for providers moat has no hand-checked table for. DeepSeek is deliberately excluded from
 * this path: models.dev's DeepSeek prices are wrong (see `lib/pricing.ts`), which is the whole
 * reason that table exists.
 */
export type CatalogCost = {
  input: number
  output: number
  cacheRead?: number
}

export type CatalogModel = {
  id: string
  name?: string
  toolCall: boolean
  context?: number
  output?: number
  reasoning?: boolean
  attachment?: boolean
  cost?: CatalogCost
}

export type CatalogProvider = {
  id: string
  name: string
  envVars: string[]
  api?: string
  npm?: string
  models: CatalogModel[]
}

export type Catalog = Map<string, CatalogProvider>

function cachePath(): string {
  return path.join(cacheDir(), "models.dev.json")
}

type RawModel = {
  name?: string
  tool_call?: boolean
  reasoning?: boolean
  attachment?: boolean
  limit?: { context?: unknown; output?: unknown }
  cost?: { input?: unknown; output?: unknown; cache_read?: unknown }
}
type RawProvider = { name?: string; env?: string[]; api?: string; npm?: string; models?: Record<string, RawModel> }

/**
 * A token count from the network, or nothing.
 *
 * `models.dev` is a fetched JSON document and its numbers are not moat's to trust.
 * This used to be a bare cast, so anything JSON can hold — a string, `null`, an
 * object, a negative number, a float — reached the config renderer, which
 * interpolated it into TOML unquoted: `model_context_window = 1e999` is `Infinity`,
 * `model_context_window = NaN` is not valid TOML at all, and Codex then refuses the
 * config with a parse error that names a line the user never wrote. A count has to
 * be a positive safe integer to be usable; everything else becomes "unknown", which
 * the renderer already handles by leaving the line out.
 */
function tokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined
  return value
}

/**
 * A price from the network, or nothing.
 *
 * Same rule as `tokenCount`: this is a fetched document, and a price that is not a finite
 * non-negative number would be multiplied into a total and printed as money. A missing price is
 * reported as "not known", which the footer already says out loud.
 */
function price(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
  return value
}

function catalogCost(cost: RawModel["cost"]): CatalogCost | undefined {
  if (!cost || typeof cost !== "object") return undefined
  const input = price(cost.input)
  const output = price(cost.output)
  if (input === undefined || output === undefined) return undefined
  const cacheRead = price(cost.cache_read)
  return { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}) }
}

export function parseCatalog(raw: Record<string, RawProvider>): Catalog {
  const catalog: Catalog = new Map()
  for (const [id, provider] of Object.entries(raw)) {
    if (!provider || typeof provider !== "object" || !provider.models) continue
    catalog.set(id, {
      id,
      name: provider.name ?? id,
      envVars: provider.env ?? [],
      api: provider.api,
      npm: provider.npm,
      models: Object.entries(provider.models).map(([modelID, model]) => ({
        id: modelID,
        name: model.name,
        toolCall: model.tool_call !== false,
        context: tokenCount(model.limit?.context),
        output: tokenCount(model.limit?.output),
        reasoning: model.reasoning,
        attachment: model.attachment,
        cost: catalogCost(model.cost),
      })),
    })
  }
  return catalog
}

export async function loadCatalog(opts: { refresh?: boolean } = {}): Promise<Catalog | null> {
  const file = cachePath()
  const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < MAX_AGE_MS
  if (fresh && !opts.refresh) {
    try {
      return parseCatalog(JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, RawProvider>)
    } catch {
      /* fall through to a fetch */
    }
  }
  try {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    const parsed = parseCatalog(JSON.parse(text) as Record<string, RawProvider>)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    log.debug(`models.dev: ${parsed.size} providers cached`)
    return parsed
  } catch (error) {
    if (fs.existsSync(file)) {
      log.warn(`could not refresh the model catalog (${(error as Error).message}); using the cached copy`)
      try {
        return parseCatalog(JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, RawProvider>)
      } catch {
        return null
      }
    }
    log.warn(`could not load the model catalog (${(error as Error).message}); falling back to moat's own table`)
    return null
  }
}

export function catalogModel(catalog: Catalog | null, providerID: string, modelID: string): CatalogModel | null {
  return catalog?.get(providerID)?.models.find((m) => m.id === modelID) ?? null
}

export function formatTokens(value: number | undefined): string {
  if (!value) return "?"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(value)
}
