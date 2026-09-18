import fs from "node:fs"
import os from "node:os"

import { fingerprint } from "../lib/hash.ts"
import { credentialsFile } from "../lib/paths.ts"

/**
 * The credential axiom, in code.
 *
 * The sandbox holds nothing worth stealing: only a copy of the project and one
 * scoped, short-lived credential that exists solely for the duration of a boot.
 * This broker is the only path by which a secret enters the box, and it has one
 * hard rule: the value is passed as an environment variable to the sandbox's
 * main process. It is never written into the rootfs, never copied into a
 * snapshot, and never included in moat's own state file (only a fingerprint is).
 *
 * What it deliberately does NOT do: forward the host environment, mount
 * ~/.ssh, mount the SSH agent socket, or read dotfiles.
 */

export type CredentialSource =
  | { kind: "flag" }
  | { kind: "env"; name: string }
  | { kind: "store"; path: string }
  | { kind: "none" }

export type StoredCredential = {
  value: string
  baseUrl?: string
  model?: string
  /** Free-form; recorded for the audit trail. v0 does not enforce provider-side scope. */
  scopes?: string[]
}

export type Store = Record<string, StoredCredential>

export type MintedCredential = {
  provider: string
  value: string
  /** Names opencode will find the credential under inside the sandbox. */
  targetEnvVars: string[]
  fingerprint: string
  mintedAt: Date
  expiresAt: Date
  ttlSeconds: number
  source: string
  baseUrl: string
  model: string
  modelId: string
  scopes: string[]
}

export type MintOptions = {
  /** Credential value, highest precedence when supplied. */
  literal?: string
  /** Name of an environment variable on the HOST holding the value. */
  envName?: string
  provider?: string
  ttlSeconds?: number
  baseUrl?: string
  model?: string
  scopes?: string[]
  /**
   * Environment variable names the provider expects, in priority order
   * (e.g. `["ZHIPU_API_KEY"]` for Z.AI). When given, the credential is injected
   * under each of these instead of moat's own name, which is what lets opencode
   * use its native models.dev definition for the provider rather than a provider
   * block moat has to describe itself.
   */
  targetEnvVars?: string[]
}

/**
 * Four hours. The TTL is enforced by stopping the agent (verified in
 * docs/VERIFICATION.md §8c). It is deliberately not the primary control, because
 * a credential that can be exfiltrated in one `curl` is not protected by a
 * clock, the primary control is what the token can do at the provider.
 */
export const DEFAULT_TTL_SECONDS = 4 * 60 * 60

/**
 * Variables moat will pick up WITHOUT being asked. Only moat-specific names:
 * moat is a tool that runs an agent with no permission prompts and an open
 * network, so silently reaching for a general-purpose provider key the user
 * happens to have exported is the wrong default. Anything else must be named
 * explicitly with `--credential-env`, which is one word of friction and forces
 * a conscious decision.
 */
const AUTO_ENV = ["MOAT_CREDENTIAL", "MOAT_MOCK_CREDENTIAL"]

/** Recognised provider keys, used only to give a useful error. Never auto-used. */
const PROVIDER_ENV = [
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
]

/** Names the sandbox's environment will contain. Values are never needed. */
export const INJECTED_ENV_NAMES = [
  "MOAT_INJECTED_CREDENTIAL",
  "MOAT_PROVIDER_BASE_URL",
  "MOAT_MODEL_ID",
  "MOAT_MODEL",
  "MOAT_CREDENTIAL_EXPIRES_AT",
  "MOAT_CREDENTIAL_TTL_SECONDS",
  "MOAT_CREDENTIAL_FINGERPRINT",
]

export function readStore(file = credentialsFile()): Store {
  if (!fs.existsSync(file)) return {}
  const mode = fs.statSync(file).mode & 0o777
  if (mode & 0o077) {
    throw new Error(
      `${file} is readable by other users (mode ${mode.toString(8)}). moat refuses to read credentials from a ` +
        `world- or group-accessible file. Run: chmod 600 ${file}`,
    )
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as Store
}

export function describeSources(store: Store): CredentialSource[] {
  const sources: CredentialSource[] = [{ kind: "flag" }]
  for (const name of AUTO_ENV) {
    if (process.env[name]) sources.push({ kind: "env", name })
  }
  if (Object.keys(store).length > 0) sources.push({ kind: "store", path: credentialsFile() })
  return sources
}

export function findCredential(opts: MintOptions): { provider: string; credential: StoredCredential; source: string } | null {
  if (opts.literal) {
    return {
      provider: opts.provider ?? "moat",
      credential: { value: opts.literal, baseUrl: opts.baseUrl, model: opts.model, scopes: opts.scopes },
      source: "--credential flag",
    }
  }

  if (opts.envName) {
    const value = process.env[opts.envName]
    if (!value) throw new Error(`--credential-env ${opts.envName} was given but that variable is not set on the host`)
    return {
      provider: opts.provider ?? "moat",
      credential: { value, baseUrl: opts.baseUrl, model: opts.model, scopes: opts.scopes },
      source: `env:${opts.envName}`,
    }
  }

  const store = readStore()
  if (opts.provider && store[opts.provider]) {
    return { provider: opts.provider, credential: store[opts.provider], source: `${credentialsFile()}#${opts.provider}` }
  }

  for (const name of AUTO_ENV) {
    const value = process.env[name]
    if (!value) continue
    const fromStore = store.moat
    return {
      provider: "moat",
      credential: {
        value,
        baseUrl: opts.baseUrl ?? fromStore?.baseUrl,
        model: opts.model ?? fromStore?.model,
        scopes: opts.scopes,
      },
      source: `env:${name}`,
    }
  }

  return null
}

/**
 * A provider key is present on the host but was not explicitly claimed. moat
 * will not use it silently; it says exactly what to do instead.
 */
export function refusedAutoCredential(): string | null {
  for (const name of PROVIDER_ENV) {
    if (process.env[name]) {
      return (
        `found ${name} in the host environment, but moat will not use a general-purpose provider key ` +
        `without being asked. The agent runs with no permission prompts and an open network, so it can read ` +
        `and exfiltrate whatever credential it is given. Pass --credential-env ${name} if that is what you ` +
        `want, or better, create a short-lived, spend-capped token for this session and pass that.`
      )
    }
  }
  return null
}

/**
 * The notice printed whenever a credential is injected. Two sentences, because
 * the accurate description is short: the agent can read the key,
 * so the key must be disposable.
 */
export function credentialRiskNotice(minted: MintedCredential): string {
  const where = minted.targetEnvVars.length > 0 ? ` as ${minted.targetEnvVars[0]}` : ""
  return (
    `injecting ${minted.provider} credential ${minted.fingerprint} (ttl ${minted.ttlSeconds}s)${where}. ` +
    `The agent can read this value and, with the network open, exfiltrate it. Use a provider-scoped, ` +
    `spend-capped token, not a general-purpose key. See docs/SPEC.md §1.2.`
  )
}

export function mint(opts: MintOptions): MintedCredential | null {
  const found = findCredential(opts)
  if (!found) return null

  const { credential } = found
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error("credential TTL must be a positive number of seconds")

  const baseUrl = (opts.baseUrl ?? credential.baseUrl ?? "").replace(/\/+$/, "")
  const model = opts.model ?? credential.model ?? ""
  if (!model) throw new Error("no model. Pass --model (or set model in ~/.moat/credentials.json).")
  const providerID = opts.provider ?? found.provider
  if (!baseUrl && !/^[a-z0-9-]+$/.test(providerID)) {
    throw new Error("no provider base URL. Pass --provider-base-url for a custom endpoint.")
  }

  const now = new Date()
  return {
    provider: opts.provider ?? found.provider,
    value: credential.value,
    targetEnvVars: opts.targetEnvVars ?? [],
    fingerprint: fingerprint(credential.value),
    mintedAt: now,
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    ttlSeconds,
    source: found.source,
    baseUrl,
    model,
    modelId: model.includes("/") ? model.split("/").slice(1).join("/") : model,
    scopes: credential.scopes ?? ["model:invoke"],
  }
}

/**
 * The environment the sandbox process receives.
 *
 * The credential is placed under BOTH moat's own name and the provider's expected
 * name. The provider name is what opencode actually uses; moat's own name is what
 * the plugin redacts and what the custom-endpoint config references.
 */
export function toSandboxEnv(minted: MintedCredential): Record<string, string> {
  const env: Record<string, string> = {
    MOAT_INJECTED_CREDENTIAL: minted.value,
    MOAT_PROVIDER_BASE_URL: minted.baseUrl,
    MOAT_MODEL_ID: minted.modelId,
    MOAT_MODEL: minted.model,
    MOAT_CREDENTIAL_EXPIRES_AT: minted.expiresAt.toISOString(),
    MOAT_CREDENTIAL_TTL_SECONDS: String(minted.ttlSeconds),
    MOAT_CREDENTIAL_FINGERPRINT: minted.fingerprint,
  }
  for (const name of minted.targetEnvVars) env[name] = minted.value
  return env
}

/**
 * host env vars that carry a credential for `provider`, in priority order.
 * Explicit user intent (`--credential-env`) always wins over convention.
 */
export function credentialCandidates(provider: string, envVars: string[]): string[] {
  const moatSpecific = [`MOAT_CREDENTIAL_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`, "MOAT_CREDENTIAL"]
  return [...moatSpecific, ...envVars]
}

export function ttlToSeconds(text: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(text.trim())
  if (!match) throw new Error(`invalid duration "${text}" (use e.g. 90s, 30m, 8h)`)
  const value = Number.parseInt(match[1]!, 10)
  const unit = match[2] || "s"
  const multiplier = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400
  return value * multiplier
}

export function describe(minted: MintedCredential): string {
  const remaining = Math.max(0, Math.round((minted.expiresAt.getTime() - Date.now()) / 1000))
  return `${minted.provider} ${minted.fingerprint} ttl=${minted.ttlSeconds}s remaining=${remaining}s source=${minted.source}`
}

export function homeDir(): string {
  return os.homedir()
}
