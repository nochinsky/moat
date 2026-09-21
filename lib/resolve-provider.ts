import {
  DEEPSEEK,
  FALLBACK_MODELS,
  checkBaseUrl,
  checkProviderID,
  customEndpoint,
  type ProviderSpec,
} from "./provider.ts"
import { resolveProviderSpec } from "./providers.ts"
import { flag, type Parsed } from "./flags.ts"

/** What the boot will talk to. */
export type ResolvedProvider = {
  id: string
  label: string
  /** The `[model_providers.<id>]` key Codex gets. Derived from `id`, validated as a TOML key. */
  codexProviderID: string
  baseUrl: string
  /** Where traffic really goes, when it is not the provider's own endpoint. */
  upstream?: string
  /** The wire API this endpoint speaks. */
  wireApi: "responses" | "chat"
  /**
   * Whether the credential for this provider is the one moat mints from its own store.
   *
   * `native` is the DeepSeek case: moat knows the provider, its default endpoint and its key
   * variable, and can fall back to them. Everything else — a named provider or a bare
   * `--base-url` — is configured by the user, and moat takes what it is given.
   */
  native: boolean
  /** The environment variable this provider's key arrives in, when one is configured. */
  envVar?: string
  modelID: string
}

/** The parts of a recorded environment this decision needs. */
export type ProviderState = {
  model?: string | null
  provider?: string | null
  providerBaseUrl?: string | null
  providerLabel?: string | null
}

/**
 * Which provider this boot talks to, and which model.
 *
 * There is no inference from the environment: a provider is named or it is the default. What
 * there is, is something to remember — an environment created against a custom endpoint has to
 * keep talking to it on the next boot even when no `--base-url` is passed again. It did not, and
 * the failure was silent and expensive in exactly the way this file exists to prevent:
 * `--base-url` was read only from the current argv, so the next `moat up` (or any codex run,
 * which reboots the box) re-resolved the provider to DeepSeek's own URL, re-rendered the config,
 * and overwrote `state.providerBaseUrl`. A local-endpoint environment quietly became a DeepSeek
 * one — measured while trying to point Codex at a local recording proxy.
 *
 * Precedence: an explicit `--base-url` or `--provider` (the user changing it on purpose), then the
 * endpoint the environment was made with, then the default provider and `--upstream`.
 *
 * Throws rather than exiting, so the decision is testable without a CLI.
 */
export function resolveProvider(p: Parsed, state?: ProviderState | null): ResolvedProvider {
  const custom = flag<string>(p, "base-url")
  const upstream = flag<string>(p, "upstream")
  const named = flag<string>(p, "provider")
  if (custom && upstream) {
    throw new Error(
      "--base-url and --upstream are different things. --base-url replaces the provider; --upstream keeps it and moves its address.",
    )
  }
  if (custom && named) {
    throw new Error(
      "--base-url and --provider are different things. --provider names a configured provider; " +
        "--base-url points at an address. Pass one, or configure the provider and pass --upstream to move its address.",
    )
  }
  const modelFlag = flag<string>(p, "model")
  const tidy = (value: string) => value.replace(/\/+$/, "")
  const deepSeekSpec = resolveProviderSpec(DEEPSEEK.id)!

  /** The shape every branch below returns, so the provider block is rendered one way. */
  const from = (spec: ProviderSpec, address: string, native: boolean, upstream?: string): ResolvedProvider => ({
    id: spec.id,
    label: spec.label,
    codexProviderID: spec.codexProviderID ?? checkProviderID(spec.id),
    baseUrl: tidy(address),
    // `--upstream` keeps the provider and moves its address: the traffic goes to `upstream`,
    // and the distinction is recorded because the filtered allowlist is built from where the
    // traffic really goes, not from the provider's own documented endpoint.
    upstream: upstream ? tidy(upstream) : undefined,
    wireApi: spec.wireApi ?? "responses",
    native,
    envVar: spec.envVar,
    modelID: modelFlag ?? state?.model?.split("/").pop() ?? spec.defaultModel ?? DEEPSEEK.defaultModel,
  })

  if (custom) {
    const problem = checkBaseUrl("base-url", custom)
    if (problem) throw new Error(problem)
    return from(customEndpoint(custom), custom, false)
  }

  if (named) {
    // A provider the user configured, or the built-in default named explicitly.
    const spec = resolveProviderSpec(named)
    if (!spec) {
      throw new Error(
        `unknown provider "${named}". Configure it first, or pass --base-url for an endpoint moat does not know.`,
      )
    }
    if (!spec.baseUrl) {
      throw new Error(
        `provider "${named}" has no endpoint configured, so moat has nowhere to send the model. ` +
          `Add one (\`moat provider add ${named} --base-url <url>\`), or pass --base-url for this run.`,
      )
    }
    return from(spec, spec.baseUrl, false)
  }

  // No flag: an environment that was created against another endpoint keeps it.
  const recordedProvider = state?.provider
  const recordedBase = state?.providerBaseUrl
  if (recordedProvider && recordedProvider !== DEEPSEEK.id && recordedBase) {
    return {
      id: recordedProvider,
      label: state?.providerLabel ?? recordedProvider,
      codexProviderID: checkProviderID(recordedProvider),
      baseUrl: tidy(recordedBase),
      upstream: undefined,
      wireApi: "responses",
      native: false,
      envVar: undefined,
      modelID: modelFlag ?? state?.model?.split("/").pop() ?? DEEPSEEK.defaultModel,
    }
  }

  if (modelFlag === undefined && state?.model?.startsWith(`${DEEPSEEK.id}/`)) {
    // Same provider, so the environment's model is a better default than the built-in one.
    return from(deepSeekSpec, upstream ?? DEEPSEEK.baseUrl, true, upstream)
  }
  return from(deepSeekSpec, upstream ?? DEEPSEEK.baseUrl, true, upstream)
}

/** The model ids `moat models` lists when the catalog cannot be reached. */
export { FALLBACK_MODELS }
