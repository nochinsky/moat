import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { fingerprint } from "../lib/hash.ts"
import { credentialsFile } from "../lib/paths.ts"
import { DEEPSEEK } from "../lib/provider.ts"

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
  /** Names the credential is injected under inside the sandbox. */
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
   * under each of these instead of moat's own name, which is what lets the provider client
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
 * moat uses one provider, so there is no ambiguity to resolve and no reason to
 * make the user say which key to use. `MOAT_CREDENTIAL` is kept as an override
 * for when the key lives under a different name (CI, a secret manager).
 */
export const CREDENTIAL_ENV_NAMES = ["DEEPSEEK_API_KEY", "MOAT_CREDENTIAL"]

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
  for (const name of CREDENTIAL_ENV_NAMES) {
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
  const keys = Object.keys(store)
  if (keys.length > 0) {
    // The named provider wins. Otherwise fall back to the ids moat itself writes
    // (`onboard` stores under `deepseek`), and only then to "there is exactly one
    // key here, so it must be the one". Without this a key saved by `moat`'s own
    // onboarding is never found again, because the boot path asks for the
    // provider by a different name than the one it was stored under.
    const candidates = [opts.provider, DEEPSEEK.id, "moat"].filter((k): k is string => Boolean(k))
    const hit = candidates.find((k) => store[k]) ?? (keys.length === 1 ? keys[0]! : undefined)
    if (hit) {
      return { provider: opts.provider ?? hit, credential: store[hit]!, source: `${credentialsFile()}#${hit}` }
    }
  }

  for (const name of CREDENTIAL_ENV_NAMES) {
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
 * The notice printed whenever a credential is injected. Two sentences, because
 * the accurate description is short: the agent can read the key,
 * so the key must be disposable.
 */
export function credentialRiskNotice(
  minted: MintedCredential,
  egress: "open" | "isolated" | "filtered" = "open",
): string {
  const reach =
    egress === "filtered"
      ? "The agent can read this value; its egress is restricted to an allowlist, but anything on that " +
        "allowlist, and DNS, can still carry it out."
      : egress === "isolated"
        ? "The agent can read this value and send it anywhere: its namespace is isolated from yours, its " +
          "egress is not filtered."
        : "The agent can read this value and, with the network open, exfiltrate it."
  const where = minted.targetEnvVars.length > 0 ? ` as ${minted.targetEnvVars[0]}` : ""
  const argv =
    minted.source === "--credential flag"
      ? " It is also on this command line (visible in ps to other local users) and in your shell history; " +
        "prefer --credential-env NAME or ~/.moat/credentials.json."
      : ""
  return (
    `injecting ${minted.provider} credential ${minted.fingerprint} (ttl ${minted.ttlSeconds}s)${where}. ` +
    `${reach} Use a spend-capped key with a low limit. See docs/SPEC.md §1.2.${argv}`
  )
}

/**
 * Look for the credential value on disk inside the rootfs.
 *
 * The value is only ever meant to exist in the sandbox process environment. If
 * the runtime or the agent persists it anywhere (auth state, a log, a session
 * file), "no credential in the image" is already false, so a boot that finds it
 * must not be reported as healthy. The pattern is fed to grep on stdin, so the
 * value never appears in a host process's argv.
 */
export function scanRootfsForCredential(rootfs: string, value: string): string[] {
  if (!value) return []
  const candidates = [
    // Where Codex would keep an auth file if it ever wrote one; moat tells it to read the key
    // from the environment, so finding anything here is already unexpected.
    "root/.codex",
    "root/.config",
    "root/.cache",
    "var/log/moat",
    ".moat",
    "tmp",
  ]
    .map((rel) => path.join(rootfs, rel))
    .filter((dir) => fs.existsSync(dir))
  if (candidates.length === 0) return []
  const result = spawnSync("grep", ["-rlF", "-f", "-", "--binary-files=text", ...candidates], {
    input: `${value}\n`,
    encoding: "utf8",
  })
  if (result.status !== 0) return []
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort()
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
 * The provider configuration the box needs, credential or not.
 *
 * These three used to be set only inside toSandboxEnv(minted), so a boot with
 * --no-credential — a documented mode — left the custom-endpoint provider block with
 * an empty base URL. The runtime then resolved {env:MOAT_PROVIDER_BASE_URL} to an empty
 * string and every model call died *inside the box* with
 * `TypeError [ERR_INVALID_URL]: "/chat/completions" cannot be parsed as a URL`, while
 * the host printed nothing but "0 tool calls". A base URL and a model id are
 * configuration, not secrets; only the credential is a secret.
 */
export function sandboxProviderEnv(input: { baseUrl: string; model: string; modelId: string }): Record<string, string> {
  return {
    MOAT_PROVIDER_BASE_URL: input.baseUrl,
    MOAT_MODEL_ID: input.modelId,
    MOAT_MODEL: input.model,
  }
}

/**
 * The environment names a doctor probe has to inject to model a real box.
 *
 * The probe is an ephemeral boot, and it has to look like the box the agent actually gets
 * or the environment check measures a cleaner box than reality. Two corrections over one
 * shared list: the credential names only when the environment records a credential — a
 * `--no-credential` box has none, and injecting them made the doctor report a credential
 * exposure for a box that deliberately had nothing stealable in it — and the provider's
 * own variable name only for the native provider, because a custom endpoint receives the
 * value under moat's name and never as `DEEPSEEK_API_KEY`.
 */
export function doctorInjectedVarNames(opts: { credential: boolean; native: boolean }): string[] {
  const names = ["MOAT_PROVIDER_BASE_URL", "MOAT_MODEL_ID", "MOAT_MODEL"]
  if (!opts.credential) return names
  names.push(...INJECTED_ENV_NAMES)
  if (opts.native) names.push(DEEPSEEK.envVar)
  return [...new Set(names)]
}

/**
 * The environment the sandbox process receives.
 *
 * The credential is placed under BOTH moat's own name and the provider's expected name. The
 * provider name is what the native provider's API expects and what Codex is told to read
 * (`env_key`); moat's own name is what the custom-endpoint config references.
 */
export function toSandboxEnv(minted: MintedCredential): Record<string, string> {
  const env: Record<string, string> = {
    ...sandboxProviderEnv(minted),
    MOAT_INJECTED_CREDENTIAL: minted.value,
    MOAT_CREDENTIAL_EXPIRES_AT: minted.expiresAt.toISOString(),
    // The box computes how long its credential has left from this, rather than
    // counting the TTL from its own start: a slow boot used to give the agent the
    // full TTL *after* a credential that had been minted seconds earlier.
    MOAT_CREDENTIAL_EXPIRES_EPOCH: String(Math.floor(minted.expiresAt.getTime() / 1000)),
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
export function credentialCandidates(envVars: string[]): string[] {
  return ["MOAT_CREDENTIAL", ...envVars]
}

/** Longest TTL a JavaScript Date can still represent as a real instant. */
const MAX_TTL_SECONDS = 30 * 24 * 3600

export function ttlToSeconds(text: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(text.trim())
  if (!match) throw new Error(`invalid duration "${text}" (use e.g. 90s, 30m, 8h)`)
  const value = Number.parseInt(match[1]!, 10)
  const unit = match[2] || "s"
  const multiplier = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400
  const seconds = value * multiplier
  // Past the Date range the expiry becomes an Invalid Date, which is a RangeError
  // from toISOString() and a null expiresAt in state.json — either a crash or a
  // credential that never expires. Refuse the input instead.
  if (seconds > MAX_TTL_SECONDS) {
    throw new Error(`duration "${text}" is longer than ${MAX_TTL_SECONDS / 86400} days, which a credential expiry cannot represent`)
  }
  return seconds
}

export function describe(minted: MintedCredential): string {
  const remaining = Math.max(0, Math.round((minted.expiresAt.getTime() - Date.now()) / 1000))
  return `${minted.provider} ${minted.fingerprint} ttl=${minted.ttlSeconds}s remaining=${remaining}s source=${minted.source}`
}

export function homeDir(): string {
  return os.homedir()
}
