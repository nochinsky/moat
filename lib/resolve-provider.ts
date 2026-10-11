import { DEEPSEEK, FALLBACK_MODELS, checkBaseUrl, checkProviderID, customEndpoint, type ProviderSpec } from "./provider.ts"
import { resolveProviderSpec } from "./providers.ts"
import { flag, type Parsed } from "./flags.ts"

export type ResolvedProvider = {
  id: string
  label: string
  baseUrl: string
  upstream?: string
  wireApi: "responses" | "chat"
  native: boolean
  envVar?: string
  effortLevels?: string[]
  defaultEffort?: string
  modelID: string
}

export type ProviderState = {
  model?: string | null
  provider?: string | null
  providerBaseUrl?: string | null
  providerLabel?: string | null
  wireApi?: "responses" | "chat"
}

/** Explicit flags, then this environment's configuration, then DeepSeek. Never infer a provider. */
export function resolveProvider(p: Parsed, state?: ProviderState | null): ResolvedProvider {
  const custom = flag<string>(p, "base-url")
  const upstream = flag<string>(p, "upstream")
  const named = flag<string>(p, "provider")
  const protocol = flag<string>(p, "wire-api")
  if (custom !== undefined && upstream !== undefined) {
    throw new Error("--base-url and --upstream are different things. --base-url replaces the provider; --upstream keeps it and moves its address.")
  }
  if (custom !== undefined && named !== undefined) {
    throw new Error("--base-url and --provider are different things. --provider names a configured provider; --base-url points at an address. Pass one, or configure the provider and pass --upstream to move its address.")
  }
  if (protocol !== undefined && protocol !== "responses" && protocol !== "chat") throw new Error('--wire-api must be "responses" or "chat"')
  let spec: ProviderSpec
  let address: string
  if (custom !== undefined) {
    spec = customEndpoint(custom)
    address = custom
  } else if (named !== undefined) {
    const configured = resolveProviderSpec(named)
    if (!configured) throw new Error(`unknown provider "${named}". Configure it first, or pass --base-url for an endpoint moat does not know.`)
    if (!configured.baseUrl && upstream === undefined) throw new Error(`provider "${named}" has no endpoint configured; add one with moat provider add ${named} --base-url <url>`)
    spec = configured
    address = upstream ?? configured.baseUrl!
  } else if (state?.provider && state.providerBaseUrl) {
    spec = resolveProviderSpec(state.provider) ?? { id: state.provider, label: state.providerLabel ?? state.provider }
    address = upstream ?? state.providerBaseUrl
  } else {
    spec = resolveProviderSpec(DEEPSEEK.id)!
    address = upstream ?? DEEPSEEK.baseUrl
  }
  checkProviderID(spec.id)
  const problem = checkBaseUrl(custom !== undefined ? "base-url" : "upstream", address)
  if (problem) throw new Error(problem)
  // Strip only the provider prefix: a model id may itself contain slashes.
  const recordedModel = state?.provider === spec.id && state.model?.startsWith(`${spec.id}/`)
    ? state.model.slice(spec.id.length + 1) : undefined
  return {
    id: spec.id,
    label: spec.label,
    baseUrl: address.replace(/\/+$/, ""),
    upstream: upstream?.replace(/\/+$/, ""),
    wireApi: protocol as "responses" | "chat" | undefined ?? (state?.provider === spec.id ? state.wireApi : undefined) ?? spec.wireApi ?? "responses",
    native: spec.id === DEEPSEEK.id,
    envVar: spec.envVar,
    effortLevels: spec.effortLevels,
    defaultEffort: spec.defaultEffort,
    modelID: flag<string>(p, "model") ?? recordedModel ?? spec.defaultModel ?? DEEPSEEK.defaultModel,
  }
}

export { FALLBACK_MODELS }
