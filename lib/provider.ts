/**
 * DeepSeek, and nothing else.
 *
 * moat targets one provider. That removes a provider registry, provider flags,
 * environment inference and most of the credential broker, which is worth more
 * than the flexibility it costs.
 *
 * What it does not remove is the ability to point at *any* OpenAI-compatible
 * endpoint via `--base-url`. Two things depend on it: moat's own test suite runs
 * against a local stub, and DeepSeek-compatible gateways exist. It is an escape
 * hatch, not a provider system.
 */

export const DEEPSEEK = {
  /** The name opencode and the models.dev catalog use. */
  opencodeID: "deepseek",
  label: "DeepSeek",
  /** The one environment variable that holds the key. */
  envVar: "DEEPSEEK_API_KEY",
  baseUrl: "https://api.deepseek.com",
  npm: "@ai-sdk/openai-compatible",
  /**
   * `deepseek-flash`, not `deepseek-v4-flash`.
   *
   * DeepSeek retired the versioned names: requests for `deepseek-v4-flash` and
   * `deepseek-v4-flash-vision-exp` are served by the current DeepSeek-V4.1-Flash
   * and billed at the Flash price, which is what `deepseek-flash` names
   * directly. Both work today and are the same model at the same price, so
   * defaulting to the current name costs nothing and will not break when the
   * old ones stop being accepted.
   */
  defaultModel: "deepseek-flash",
  /**
   * Thinking is on by default at the provider, and `high` is the level it
   * defaults to — so this is not moat imposing an opinion, it is moat stating
   * one instead of leaving it implicit. It is also what the `/think` menu marks,
   * and what `/think default` returns to.
   */
  defaultEffort: "high",
} as const

/** Used when `--base-url` points somewhere else. */
export const CUSTOM_ENDPOINT = {
  opencodeID: "moat",
  label: "custom OpenAI-compatible endpoint",
  npm: "@ai-sdk/openai-compatible",
} as const

/** Shown when the catalog cannot be reached. The catalog is the real source. */
export const FALLBACK_MODELS = [
  "deepseek-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
] as const

/** Every environment variable moat will accept a DeepSeek key from. */
export const CREDENTIAL_ENV_VARS = [DEEPSEEK.envVar, "MOAT_CREDENTIAL"] as const

export function isDeepSeekHost(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, "") === DEEPSEEK.baseUrl
}
