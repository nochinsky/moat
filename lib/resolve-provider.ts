import { CUSTOM_ENDPOINT, DEEPSEEK } from "./provider.ts"
import { flag, type Parsed } from "./flags.ts"

/** What the boot will talk to: DeepSeek, or an OpenAI-compatible endpoint. */
export type ResolvedProvider = {
  opencodeID: string
  label: string
  npm: string
  baseUrl: string
  /** Where traffic really goes, when it is not the catalog's own endpoint. */
  upstream?: string
  native: boolean
  modelID: string
}

/** The parts of a recorded environment this decision needs. */
export type ProviderState = {
  model?: string | null
  provider?: string | null
  providerBaseUrl?: string | null
}

/**
 * DeepSeek, or whatever endpoint the flags — or the environment — point at.
 *
 * There is no provider to choose and nothing to infer, but there *is* something to
 * remember: an environment created against a custom endpoint has to keep talking to it on
 * the next boot even when no `--base-url` is passed again. It did not, and the failure was
 * silent and expensive in exactly the way this file exists to prevent: `--base-url` was
 * read only from the current argv, so the next `moat up` (or any codex run, which reboots
 * the box) re-resolved the provider to DeepSeek's own URL, re-rendered the config, and
 * overwrote `state.providerBaseUrl`. A local-endpoint environment quietly became a
 * DeepSeek one — measured while trying to point Codex at a local recording proxy.
 *
 * The precedence is: an explicit `--base-url` (the user changing it on purpose), then the
 * endpoint the environment was made with, then DeepSeek and `--upstream`.
 *
 * Throws rather than exiting, so the decision is testable without a CLI.
 */
export function resolveProvider(p: Parsed, state?: ProviderState | null): ResolvedProvider {
  const custom = flag<string>(p, "base-url")
  const upstream = flag<string>(p, "upstream")
  if (custom && upstream) {
    throw new Error(
      "--base-url and --upstream are different things. --base-url replaces the provider; --upstream keeps it and moves its address.",
    )
  }
  const modelFlag = flag<string>(p, "model")
  const tidy = (value: string) => value.replace(/\/+$/, "")

  if (custom) {
    return {
      opencodeID: CUSTOM_ENDPOINT.opencodeID,
      label: CUSTOM_ENDPOINT.label,
      npm: CUSTOM_ENDPOINT.npm,
      baseUrl: tidy(custom),
      upstream: undefined,
      native: false,
      modelID: modelFlag ?? state?.model?.split("/").pop() ?? DEEPSEEK.defaultModel,
    }
  }

  // No flag: an environment that was created against a custom endpoint keeps it.
  const recordedProvider = state?.provider
  const recordedBase = state?.providerBaseUrl
  if (recordedProvider && recordedProvider !== DEEPSEEK.opencodeID && recordedBase) {
    return {
      opencodeID: recordedProvider,
      label: CUSTOM_ENDPOINT.label,
      npm: CUSTOM_ENDPOINT.npm,
      baseUrl: tidy(recordedBase),
      upstream: undefined,
      native: false,
      modelID: modelFlag ?? state?.model?.split("/").pop() ?? DEEPSEEK.defaultModel,
    }
  }

  if (modelFlag === undefined && state?.model?.startsWith(`${DEEPSEEK.opencodeID}/`)) {
    // Same provider, so the environment's model is a better default than the built-in one.
    return {
      opencodeID: DEEPSEEK.opencodeID,
      label: DEEPSEEK.label,
      npm: DEEPSEEK.npm,
      baseUrl: upstream ? tidy(upstream) : DEEPSEEK.baseUrl,
      upstream: upstream ? tidy(upstream) : undefined,
      native: true,
      modelID: state.model.slice(DEEPSEEK.opencodeID.length + 1),
    }
  }
  return {
    opencodeID: DEEPSEEK.opencodeID,
    label: DEEPSEEK.label,
    npm: DEEPSEEK.npm,
    baseUrl: upstream ? tidy(upstream) : DEEPSEEK.baseUrl,
    upstream: upstream ? tidy(upstream) : undefined,
    native: true,
    modelID: modelFlag ?? DEEPSEEK.defaultModel,
  }
}
