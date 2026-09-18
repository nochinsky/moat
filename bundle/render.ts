import { BUNDLE_CONFIG, BUNDLE_DIR, BUNDLE_PLUGIN, SANDBOX_WORKDIR } from "../lib/pins.ts"

/**
 * The opencode config is *rendered per boot*, not shipped static.
 *
 * That is what makes multi-provider support accurate: for a provider the models.dev
 * catalog defines (`zai`, `deepseek`, `openai`, …) moat writes no provider block
 * at all and lets opencode supply the real base URL, context window, output limit
 * and tool-call support. moat only declares a provider itself when it has to, 
 * a custom OpenAI-compatible endpoint, and then it is explicit about the limits
 * it is guessing.
 *
 * The invariants that must never change are asserted in `assertInvariants` below
 * and re-checked by the plugin at config-load time.
 */

export type ToolPreset = "core" | "extended"

export const TOOL_PRESETS: Record<ToolPreset, string[]> = {
  /** Everything a coding agent needs and nothing else. This is the default. */
  core: ["read", "write", "edit", "apply_patch", "glob", "grep", "bash", "todowrite", "question"],
  /**
   * Adds `webfetch` (opencode's own HTML-to-text fetcher) and `task` (spawns
   * sub-agents). Neither changes the security posture, `bash` + `curl` already
   * reaches the network, but both widen what the model can reach for, so they
   * are opt-in.
   */
  extended: [
    "read",
    "write",
    "edit",
    "apply_patch",
    "glob",
    "grep",
    "bash",
    "todowrite",
    "question",
    "webfetch",
    "task",
  ],
}

/** Every built-in opencode ships (packages/core/src/tool/builtins.ts) minus the ones we keep. */
export const ALL_BUILTINS = [
  "apply_patch",
  "bash",
  "edit",
  "glob",
  "grep",
  "question",
  "read",
  "skill",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
  "task",
]

export function excludedFor(preset: ToolPreset): string[] {
  const curated = TOOL_PRESETS[preset]
  return ALL_BUILTINS.filter((name) => !curated.includes(name))
}

export type RenderInput = {
  /**
   * Which provider block, if any, to write.
   *
   * DeepSeek needs none: opencode is built on the models.dev catalog, which
   * already describes it, so moat sets the model and lets opencode supply the
   * base URL, the npm SDK, the context window and the tool-call support. Only a
   * custom endpoint has to be described here, and then moat states the limits
   * rather than guessing them.
   */
  provider: { opencodeID: string; npm: string; native: boolean }
  modelID: string
  baseUrl: string
  preset: ToolPreset
  /** From the models.dev catalog, when it is known. */
  modelMeta?: { context?: number; output?: number; toolCall?: boolean; reasoning?: boolean; attachment?: boolean }
}

export type RenderedBundle = {
  config: string
  tools: string
  /** The provider id opencode will see: `<native id>` or `moat` for a custom endpoint. */
  providerID: string
  /** The full `provider/model` string passed to opencode. */
  model: string
  curated: string[]
  excluded: string[]
}

export function renderBundle(input: RenderInput): RenderedBundle {
  // `question` is always advertised. Whether a human is listening is a property
  // of the session, not of the boot: moat may be started headless and attached
  // later. Instead of guessing at boot time, the instructions say a question may
  // or may not reach anyone, and a question that arrives with nobody attached is
  // rejected outright so the agent can get on with deciding for itself.
  const curated = TOOL_PRESETS[input.preset]
  const excluded = ALL_BUILTINS.filter((name) => !curated.includes(name))
  const native = input.provider.native
  const providerID = native ? input.provider.opencodeID : "moat"
  const model = `${providerID}/${input.modelID}`

  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    model,
    small_model: model,
    share: "disabled",
    autoupdate: false,
    // The only rule, and it allows. No approval prompt can fire and no denial
    // can be tripped for a curated tool.
    permission: { "*": "allow" },
    tools: Object.fromEntries(excluded.map((name) => [name, false])),
    // Keep opencode's provider surface to the one provider in use.
    enabled_providers: [providerID],
    plugin: [BUNDLE_PLUGIN],
  }

  if (!native) {
    const meta = input.modelMeta ?? {}
    config.provider = {
      moat: {
        name: "moat custom endpoint",
        npm: input.provider.npm,
        options: {
          baseURL: "{env:MOAT_PROVIDER_BASE_URL}",
          apiKey: "{env:MOAT_INJECTED_CREDENTIAL}",
        },
        models: {
          [input.modelID]: {
            name: input.modelID,
            tool_call: meta.toolCall !== false,
            attachment: meta.attachment === true,
            reasoning: meta.reasoning === true,
            temperature: true,
            // Only declared for a custom endpoint, where nothing else knows.
            // A wrong context window makes opencode compact at the wrong moment,
            // so these are stated plainly rather than guessed generously.
            limit: {
              context: meta.context ?? 128000,
              output: meta.output ?? 32000,
            },
          },
        },
      },
    }
  }

  return {
    config: `${JSON.stringify(config, null, 2)}\n`,
    tools: `${JSON.stringify({ preset: input.preset, curated, excluded, workspace: SANDBOX_WORKDIR }, null, 2)}\n`,
    providerID,
    model,
    curated,
    excluded,
  }
}

/**
 * Invariants that make the bundle what it claims to be. Checked before the files
 * are written, and again by the plugin inside the sandbox, a config that fails
 * any of these must never reach a boot.
 */
export function assertInvariants(rendered: RenderedBundle): void {
  const parsed = JSON.parse(rendered.config) as { permission?: Record<string, string>; tools?: Record<string, boolean> }
  if (parsed.permission?.["*"] !== "allow") throw new Error("bundle invariant: permission['*'] must be 'allow'")
  const denies = Object.entries(parsed.permission ?? {}).filter(([key, value]) => key !== "*" && value === "deny")
  if (denies.length > 0) {
    throw new Error(`bundle invariant: the only permission rule may be '*', found ${JSON.stringify(denies)}`)
  }
  for (const name of rendered.excluded) {
    if (parsed.tools?.[name] !== false) throw new Error(`bundle invariant: ${name} must be omitted`)
  }
  for (const name of rendered.curated) {
    if (parsed.tools?.[name] === false) throw new Error(`bundle invariant: curated tool ${name} must not be omitted`)
  }
  if (rendered.curated.length === 0) throw new Error("bundle invariant: no curated tools")
}

export { BUNDLE_CONFIG, BUNDLE_DIR }
