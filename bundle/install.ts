import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { BUNDLE_CONFIG, BUNDLE_DIR, BUNDLE_PLUGIN, SANDBOX_WORKDIR } from "../lib/pins.ts"
import { assertInvariants, renderBundle, type RenderInput, type ToolPreset, TOOL_PRESETS } from "./render.ts"
import { renderInstructions, type InstructionsInput } from "./instructions.ts"

const here = path.dirname(fileURLToPath(import.meta.url))

export const bundleSource = {
  plugin: path.join(here, "plugin", "moat-bundle.mjs"),
}

/** Where the sandbox keeps the agent's global instructions. Verified read path. */
export const BRIEF_PATH = "/root/.config/opencode/AGENTS.md"
export const TOOLS_PATH = `${BUNDLE_DIR}/tools.json`
export const ENVIRONMENT_PATH = `${BUNDLE_DIR}/environment.json`

export type InstalledBundle = {
  config: string
  plugin: string
  tools: string
  brief: string
  environment: string
  curated: string[]
  excluded: string[]
  preset: ToolPreset
  providerID: string
  model: string
}

export type InstallOptions = {
  render: RenderInput
  brief: Omit<InstructionsInput, "workspace">
  installedPackages: string[]
}

/**
 * Install the bundle into a rootfs.
 *
 * Everything written here is text and contains no credential: the provider block
 * for a custom endpoint references `{env:MOAT_INJECTED_CREDENTIAL}`, which
 * opencode substitutes from the environment at config-load time. That is what
 * makes "never bake keys into the image" checkable, grep the image for the key
 * and you find nothing.
 *
 * Called on EVERY boot, not just at provisioning: the rootfs may come from the
 * host image cache or from an environment created days ago, and a stale plugin
 * silently running an old policy is a bug that already happened once.
 */
export function installBundle(rootfs: string, options: InstallOptions): InstalledBundle {
  const rendered = renderBundle(options.render)
  assertInvariants(rendered)

  const plugin = fs.readFileSync(bundleSource.plugin, "utf8")
  const brief = renderInstructions({ ...options.brief, workspace: SANDBOX_WORKDIR })
  const environment = `${JSON.stringify(
    {
      writtenAt: new Date().toISOString(),
      checks: options.brief.checks,
      canAsk: options.brief.canAsk,
      provider: options.brief.provider,
      model: options.brief.model,
      branch: options.brief.branch,
      profiles: options.brief.profiles,
      installedPackages: options.installedPackages,
      toolPreset: options.render.preset,
      curated: rendered.curated,
      excluded: rendered.excluded,
      workspace: SANDBOX_WORKDIR,
    },
    null,
    2,
  )}\n`

  // Fail loudly if someone tries to bake a literal secret into the bundle.
  for (const [name, text] of [
    ["opencode.json", rendered.config],
    ["AGENTS.md", brief],
    ["moat-bundle.mjs", plugin],
  ] as const) {
    if (/sk-[A-Za-z0-9]{16,}/.test(text) || /AIza[A-Za-z0-9_-]{20,}/.test(text)) {
      throw new Error(`refusing to install bundle: ${name} appears to contain a literal API key`)
    }
  }

  write(rootfs, BUNDLE_CONFIG, rendered.config, 0o644)
  write(rootfs, TOOLS_PATH, rendered.tools, 0o644)
  write(rootfs, ENVIRONMENT_PATH, environment, 0o644)
  write(rootfs, BUNDLE_PLUGIN, plugin, 0o644)
  write(rootfs, BRIEF_PATH, brief, 0o644)
  fs.chmodSync(path.join(rootfs, BUNDLE_DIR), 0o755)

  return {
    config: BUNDLE_CONFIG,
    plugin: BUNDLE_PLUGIN,
    tools: TOOLS_PATH,
    brief: BRIEF_PATH,
    environment: ENVIRONMENT_PATH,
    curated: rendered.curated,
    excluded: rendered.excluded,
    preset: options.render.preset,
    providerID: rendered.providerID,
    model: rendered.model,
  }
}

function write(rootfs: string, target: string, content: string, mode: number): void {
  const full = path.join(rootfs, target)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, { mode })
}

export { TOOL_PRESETS }
export type { ToolPreset }
