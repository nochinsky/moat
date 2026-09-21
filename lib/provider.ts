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
  /** The provider id the models.dev catalog uses, and the model-string prefix. */
  id: "deepseek",
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

/**
 * A provider moat can be pointed at: its name, its address, and the variable its key
 * arrives in.
 *
 * This is the shape `--base-url` has always produced, named. Phase 1's unlock is that the
 * *identity* is configurable rather than DeepSeek's: before it, every rendered config carried
 * `name = "DeepSeek"` in its `[model_providers.*]` block no matter what it was talking to, and
 * the provider id was the literal `deepseek-moat`.
 */
export type ProviderSpec = {
  /** The provider id. Also the prefix in the `provider/model` string and the config key. */
  id: string
  label: string
  /** The endpoint, when the provider has one. A provider configured without it needs --base-url. */
  baseUrl?: string
  /**
   * The environment variable this provider's key is expected in.
   *
   * Set for a known provider so a user with `ANTHROPIC_API_KEY` in their environment does not
   * have to rename it. Unset means moat's own name is used.
   */
  envVar?: string
  /** Which wire API the endpoint speaks. `responses` unless it only speaks chat completions. */
  wireApi?: "responses" | "chat"
  /** The model to use when the user names none. */
  defaultModel?: string
  /** A pre-validated `[model_providers.<id>]` key, when the id itself is not one. */
  codexProviderID?: string
}

/** Used when `--base-url` points somewhere else. */
export const CUSTOM_ENDPOINT = {
  id: "moat",
  label: "custom OpenAI-compatible endpoint",
  npm: "@ai-sdk/openai-compatible",
} as const

/**
 * The spec for an endpoint given only as an address.
 *
 * Its id is fixed rather than derived from the host: the id is also the `[model_providers.<id>]`
 * TOML key and the prefix in `provider/model`, and a hostname is neither of those (it can carry
 * dots and a port). The host goes in the provider's *label*, where a human reads it, and in the
 * base URL, where the runtime reads it.
 */
export function customEndpoint(baseUrl: string): ProviderSpec {
  let host = baseUrl
  try {
    host = new URL(baseUrl).host
  } catch {
    /* a caller that got this far validated it; the label is cosmetic */
  }
  return {
    id: CUSTOM_ENDPOINT.id,
    label: `${CUSTOM_ENDPOINT.label} (${host})`,
    baseUrl,
    wireApi: "responses",
  }
}

/**
 * A `[model_providers.<id>]` key Codex will accept.
 *
 * The rendered block is `[model_providers.${id}]` in TOML, so anything that is not a bare key —
 * a dot, a space, a quote, a newline — either breaks the parse or, worse, appends a section the
 * user did not ask for. A provider id comes from a flag or from state, so it is checked rather
 * than trusted. This is the same rule `renderCodexConfig` applies, in the place that can name
 * the offending value.
 */
export function checkProviderID(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(
      `invalid provider id "${id}": a provider id becomes a TOML key (model_providers.${id}), ` +
        "so it may contain only letters, digits, dashes and underscores",
    )
  }
  return id
}

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

/**
 * Is this a URL moat can actually use as a provider address?
 *
 * `new URL()` alone is a parse check, not a usability check, and that mattered:
 * `localhost:11434/v1` — the scheme-less form of the endpoint moat's own help text
 * suggests — parses as protocol `localhost:` with an **empty hostname**. Measured
 * before this check existed: `moat up --base-url localhost:11434/v1` provisioned,
 * copied in and booted a *filtered* sandbox whose allowlist contained no provider
 * address at all (exit 0, ready in 13s), so every model call the agent made would
 * fail, and `moat doctor` printed "the provider is reachable" for a probe it never
 * ran. A filtered box cannot work without a provider host, so the address has to be
 * one before anything is provisioned.
 *
 * Returns null when the value is usable, or the message to fail with.
 */
export function checkBaseUrl(flagName: string, value: string): string | null {
  if (value.trim().length === 0) return `--${flagName} needs a URL`
  // A value with no "://" that starts like a host is almost always a forgotten
  // scheme; saying so is the difference between a fixable error and a puzzle. It is
  // computed before parsing because `api.deepseek.com` does not parse at all while
  // `localhost:11434/v1` parses as a scheme with no host — same mistake, two paths.
  const schemeLess = !value.includes("://") && /^[a-z0-9][a-z0-9.-]*(:\d+)?(\/|$)/i.test(value)
  const hint = schemeLess ? `\n  did you mean http://${value}?` : ""
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `--${flagName} is not a URL: ${value}${hint}`
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `--${flagName} must be an http:// or https:// URL: ${value}${hint}`
  }
  if (url.hostname.length === 0) {
    return `--${flagName} has no host: ${value}${hint}`
  }
  return null
}
