/**
 * Providers moat knows about by name.
 *
 * The important discovery behind this file: opencode is built on the models.dev
 * catalog, which ships maintained definitions for 222 providers, including all
 * three that moat is being prepared for. Each entry carries the base URL, the npm
 * SDK package, the context window, the output limit and whether the model
 * supports tool calling. That metadata is not something to reimplement; if moat
 * guesses a context window wrong, opencode compacts at the wrong time.
 *
 * So for a *native* provider moat does not write a provider block at all. It
 * injects the credential under the environment variable name opencode expects and
 * sets `model` to `<provider>/<model>`. opencode looks the rest up.
 *
 * For anything not in the catalog (`--provider-base-url`), moat falls back to
 * declaring a custom OpenAI-compatible provider, which is the only place it has
 * to supply limits itself.
 */

export type ProviderSpec = {
  /** The name you type: `--provider zai`. */
  id: string
  /** The provider id opencode/models.dev uses for it. */
  opencodeID: string
  label: string
  /** Environment variables opencode reads for this provider, in priority order. */
  envVars: string[]
  /** Base URL, used only when moat has to declare the provider itself. */
  baseUrl: string
  /** AI SDK package opencode loads for this provider. */
  npm: string
  /** Used when `--model` is not given. */
  defaultModel: string
  /** True when models.dev defines it, so metadata comes from the catalog. */
  native: boolean
  note: string
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "zai",
    opencodeID: "zai",
    label: "Z.AI (GLM)",
    envVars: ["ZHIPU_API_KEY", "ZAI_API_KEY"],
    baseUrl: "https://api.z.ai/api/paas/v4",
    npm: "@ai-sdk/openai-compatible",
    defaultModel: "glm-4.6",
    native: true,
    note: "GLM models. Also available as `zai-coding-plan` for a coding subscription.",
  },
  {
    id: "deepseek",
    opencodeID: "deepseek",
    label: "DeepSeek",
    envVars: ["DEEPSEEK_API_KEY"],
    baseUrl: "https://api.deepseek.com",
    npm: "@ai-sdk/openai-compatible",
    defaultModel: "deepseek-v4-pro",
    native: true,
    note: "Direct API. An OpenAI-compatible endpoint.",
  },
  {
    id: "openai",
    opencodeID: "openai",
    label: "OpenAI",
    envVars: ["OPENAI_API_KEY"],
    baseUrl: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
    defaultModel: "gpt-5.4",
    native: true,
    note: "Native SDK, not the compatible shim.",
  },
  // The rest are conveniences, not commitments: they are here because the
  // catalog already describes them accurately and a one-word switch is worth
  // having. Anything absent from this list still works via --provider-base-url.
  {
    id: "anthropic",
    opencodeID: "anthropic",
    label: "Anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
    baseUrl: "https://api.anthropic.com/v1",
    npm: "@ai-sdk/anthropic",
    defaultModel: "claude-sonnet-4-5",
    native: true,
    note: "Native SDK, not an OpenAI-compatible shim.",
  },
  {
    id: "openrouter",
    opencodeID: "openrouter",
    label: "OpenRouter",
    envVars: ["OPENROUTER_API_KEY"],
    baseUrl: "https://openrouter.ai/api/v1",
    npm: "@openrouter/ai-sdk-provider",
    defaultModel: "anthropic/claude-sonnet-4.5",
    native: true,
    note: "One key, many models. Model ids are namespaced: vendor/model.",
  },
  {
    id: "groq",
    opencodeID: "groq",
    label: "Groq",
    envVars: ["GROQ_API_KEY"],
    baseUrl: "https://api.groq.com/openai/v1",
    npm: "@ai-sdk/groq",
    defaultModel: "llama-3.3-70b-versatile",
    native: true,
    note: "Very fast inference.",
  },
  {
    id: "moonshot",
    opencodeID: "moonshotai",
    label: "Moonshot (Kimi)",
    envVars: ["MOONSHOT_API_KEY"],
    baseUrl: "https://api.moonshot.ai/v1",
    npm: "@ai-sdk/openai-compatible",
    defaultModel: "kimi-k2-0905-preview",
    native: true,
    note: "Kimi models.",
  },
  {
    id: "local",
    opencodeID: "moat",
    label: "Local / custom OpenAI-compatible endpoint",
    envVars: [],
    baseUrl: "",
    npm: "@ai-sdk/openai-compatible",
    defaultModel: "",
    native: false,
    note: "Ollama, llama.cpp, vLLM, LiteLLM, LM Studio, anything speaking /v1. Requires --provider-base-url.",
  },
]

export function findProvider(id: string): ProviderSpec | undefined {
  const needle = id.toLowerCase()
  return (
    PROVIDERS.find((p) => p.id === needle) ??
    PROVIDERS.find((p) => p.opencodeID === needle) ??
    PROVIDERS.find((p) => p.id.startsWith(needle))
  )
}

export function providerIds(): string[] {
  return PROVIDERS.map((p) => p.id)
}

export function describeProviders(): string {
  return PROVIDERS.map((p) => {
    const env = p.envVars.length > 0 ? p.envVars.join(" | ") : "n/a (custom endpoint)"
    return `  ${p.id.padEnd(12)} ${p.label.padEnd(42)} ${env}`
  }).join("\n")
}
