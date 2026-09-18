/**
 * What a DeepSeek request actually costs.
 *
 * This exists because the price opencode reports is wrong. opencode bills from
 * the models.dev catalog, and for `deepseek-v4-pro` that catalog says
 * input 0.435 / output 0.87 / cache-read 0.003625 per 1M, where DeepSeek's own
 * pricing page says 0.66 / 1.98 / 0.022 off-peak — so the running total it
 * shows is roughly a third of the real one. It also has no notion of peak
 * pricing, which doubles every rate.
 *
 * The numbers below are transcribed from https://api-docs.deepseek.com/quick_start/pricing
 * (USD per 1M tokens). If DeepSeek changes them, this file is the one place to
 * change, and `moat doctor` prints the table so a stale copy is visible.
 *
 * Verified against a live account, which is how the token fields were pinned
 * down: for a turn reported as input=6504, output=47, reasoning=0,
 * cache.read=2304, opencode reported cost=0.002878482, which is exactly
 * 6504·0.435 + 2304·0.003625 + 47·0.87 per million. A second turn with
 * reasoning=53 only reconciled once reasoning was billed at the *output* rate,
 * i.e. output and reasoning are separate fields that are both billed as output.
 */

export type Price = {
  /** USD per 1M input tokens that were served from the context cache. */
  cacheHit: number
  /** USD per 1M input tokens that were not. */
  cacheMiss: number
  /** USD per 1M output tokens, reasoning tokens included. */
  output: number
}

export type ModelPricing = { peak: Price; offPeak: Price }

const FLASH: ModelPricing = {
  offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
}

const V4_PRO: ModelPricing = {
  offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
  peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
}

/**
 * The two current models, plus the two retired names DeepSeek still accepts.
 *
 * The docs are explicit that `deepseek-v4-flash` and
 * `deepseek-v4-flash-vision-exp` are legacy: requests for them are served by
 * DeepSeek-V4.1-Flash and billed at the Flash price. They are listed here so
 * their cost is still right, and flagged `retired` so the UI can say so rather
 * than presenting four current models when there are two.
 */
const TABLE: Record<string, { pricing: ModelPricing; retired: boolean }> = {
  "deepseek-flash": { pricing: FLASH, retired: false },
  "deepseek-v4-pro": { pricing: V4_PRO, retired: false },
  "deepseek-v4-flash": { pricing: FLASH, retired: true },
  "deepseek-v4-flash-vision-exp": { pricing: FLASH, retired: true },
}

export function isRetiredModel(modelID: string): boolean {
  return TABLE[modelID]?.retired ?? false
}

/**
 * Peak is 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday; everything else is
 * off-peak and half price. Note this is UTC, not the user's local time — the
 * page says UTC and the whole schedule is quoted that way.
 */
export function isPeak(at: Date = new Date()): boolean {
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = at.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/** How the next request would be billed, for display. */
export function describeRate(at: Date = new Date()): string {
  return isPeak(at) ? "peak" : "off-peak"
}

export type TokenUsage = {
  /** Input tokens that missed the cache. */
  input: number
  /** Visible output tokens. */
  output: number
  /** Reasoning tokens. Billed at the output rate, as a separate field. */
  reasoning: number
  /** Input tokens served from the cache. */
  cacheRead: number
}

export type Cost = {
  usd: number
  /** True when the model is in the table; false means the figure is unknown. */
  known: boolean
  peak: boolean
}

/**
 * The cost of one request.
 *
 * `input` is the cache-*miss* count and `cacheRead` the cache-hit count —
 * opencode adds the cached tokens into a separate field rather than into
 * `input`, which is not the obvious reading and was pinned down by reconciling
 * its own arithmetic.
 */
export function computeCost(modelID: string, usage: TokenUsage, at: Date = new Date()): Cost {
  const entry = TABLE[modelID]
  const peak = isPeak(at)
  if (!entry) return { usd: 0, known: false, peak }
  const price = peak ? entry.pricing.peak : entry.pricing.offPeak
  const usd =
    (usage.input / 1e6) * price.cacheMiss +
    (usage.cacheRead / 1e6) * price.cacheHit +
    ((usage.output + usage.reasoning) / 1e6) * price.output
  return { usd, known: true, peak }
}

/** Pull the usage fields out of an opencode message's `tokens` object. */
export function usageOf(tokens: unknown): TokenUsage {
  const t = (tokens ?? {}) as Record<string, unknown>
  const cache = (t.cache ?? {}) as Record<string, unknown>
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)
  return {
    input: num(t.input),
    output: num(t.output),
    reasoning: num(t.reasoning),
    cacheRead: num(cache.read),
  }
}

/** Total prompt tokens, which is `input` plus the cached part. */
export function promptTokens(usage: TokenUsage): number {
  return usage.input + usage.cacheRead
}

/**
 * Money, at a precision that stays readable.
 *
 * A single turn is fractions of a cent, so two decimals would print `$0.00`
 * for real spending. Sub-cent amounts get four decimals instead.
 */
export function formatUSD(amount: number): string {
  if (amount === 0) return "$0.00"
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  if (amount < 10) return `$${amount.toFixed(3)}`
  return `$${amount.toFixed(2)}`
}

/** Token counts, in the shorthand people read at a glance. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}k`
  return String(count)
}

export function pricingTable(): { model: string; retired: boolean; offPeak: Price; peak: Price }[] {
  return Object.entries(TABLE).map(([model, entry]) => ({
    model,
    retired: entry.retired,
    offPeak: entry.pricing.offPeak,
    peak: entry.pricing.peak,
  }))
}
