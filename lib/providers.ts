import fs from "node:fs"
import path from "node:path"

import { moatHome, partPath } from "./paths.ts"
import { checkProviderID, DEEPSEEK, type ProviderSpec } from "./provider.ts"

/**
 * Providers the user has configured, beside the credential store.
 *
 * Phase 1's unlock is that the provider and model are whatever the user configures, with
 * DeepSeek as the default. This is where "configures" lives: a small JSON file under
 * `~/.moat/`, written by `moat provider add` and read by every command that resolves a
 * provider.
 *
 * Deliberately not a *registry*: there is no built-in list to choose from, no inference from the
 * environment, and nothing is discovered. A provider exists because the user declared it, which
 * is what keeps "no `--provider` inference" true in spirit — the flag names a thing the user
 * wrote down, it does not guess.
 *
 * The file holds no credential: only the *name* of the environment variable the key lives in.
 * That is the same rule the rest of moat follows (`CredentialRecord` stores a fingerprint), and
 * it is why this file can be 0644 without leaking anything.
 */

export type StoredProvider = {
  id: string
  label: string
  baseUrl?: string
  /** Name of the environment variable on the HOST holding the key. Never the value. */
  envVar?: string
  wireApi?: "responses" | "chat"
  defaultModel?: string
  /** The reasoning levels this provider's models implement, when they are not moat's default. */
  effortLevels?: string[]
  /** The level to use when the user passes no `--effort`. */
  defaultEffort?: string
}

export type ProviderStore = Record<string, StoredProvider>

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** `~/.moat/providers.json`. */
export function providersFile(): string {
  return path.join(moatHome(), "providers.json")
}

export function readProviderStore(file = providersFile()): ProviderStore {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
    const store: ProviderStore = {}
    for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
      const spec = validateStoredProvider(id, entry)
      if (spec) store[id] = spec
    }
    return store
  } catch {
    // A missing file is the normal first-run state, and an unreadable one must not take every
    // command down: the caller falls back to the default provider and says so.
    return {}
  }
}

/**
 * One entry from the file, or null when it cannot be used.
 *
 * The file is user-editable, so every field is checked here rather than at the point of use:
 * an id becomes a TOML key, and an env var name becomes argv-adjacent configuration.
 */
export function validateStoredProvider(id: string, entry: unknown): StoredProvider | null {
  if (!PROVIDER_ID.test(id)) return null
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
  const record = entry as Record<string, unknown>
  const str = (key: string): string | undefined =>
    typeof record[key] === "string" && (record[key] as string).trim().length > 0 ? (record[key] as string).trim() : undefined
  const wireApi = record.wireApi === "chat" ? "chat" : record.wireApi === "responses" ? "responses" : undefined
  const envVar = str("envVar")
  if (envVar !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) return null
  const baseUrl = str("baseUrl")
  if (baseUrl !== undefined) {
    try {
      const url = new URL(baseUrl)
      if (url.protocol !== "http:" && url.protocol !== "https:") return null
      if (url.hostname.length === 0) return null
    } catch {
      return null
    }
  }
  const effortLevels = Array.isArray(record.effortLevels)
    ? (record.effortLevels as unknown[]).filter((level): level is string => typeof level === "string" && level.length > 0)
    : undefined
  return {
    id,
    label: str("label") ?? id,
    baseUrl,
    envVar,
    wireApi,
    defaultModel: str("defaultModel"),
    ...(effortLevels && effortLevels.length > 0 ? { effortLevels } : {}),
    ...(str("defaultEffort") ? { defaultEffort: str("defaultEffort") } : {}),
  }
}

/** Write the store, 0600 like the credential file, through write-then-rename. */
export function writeProviderStore(store: ProviderStore, file = providersFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = partPath(file)
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * The spec for a provider the user named, or undefined.
 *
 * `deepseek` always resolves: it is the default provider, so it is the one entry that exists
 * without being configured. Everything else has to have been written down.
 */
export function resolveProviderSpec(id: string, store: ProviderStore = readProviderStore()): ProviderSpec | undefined {
  if (id === DEEPSEEK.id) {
    return {
      id: DEEPSEEK.id,
      label: DEEPSEEK.label,
      baseUrl: DEEPSEEK.baseUrl,
      envVar: DEEPSEEK.envVar,
      wireApi: "responses",
      defaultModel: DEEPSEEK.defaultModel,
    }
  }
  const stored = store[id]
  if (!stored) return undefined
  return {
    id: stored.id,
    label: stored.label,
    baseUrl: stored.baseUrl,
    envVar: stored.envVar,
    wireApi: stored.wireApi,
    defaultModel: stored.defaultModel,
    effortLevels: stored.effortLevels,
    defaultEffort: stored.defaultEffort,
  }
}

/** Every configured provider, the built-in default first. */
export function listProviderSpecs(store: ProviderStore = readProviderStore()): ProviderSpec[] {
  const specs: ProviderSpec[] = [resolveProviderSpec(DEEPSEEK.id, store)!]
  for (const id of Object.keys(store).sort()) {
    if (id === DEEPSEEK.id) continue
    const spec = resolveProviderSpec(id, store)
    if (spec) specs.push(spec)
  }
  return specs
}

/** Validate an id at the point it is written, with a message naming the rule. */
export function assertProviderID(id: string): string {
  if (!PROVIDER_ID.test(id)) {
    throw new Error(
      `invalid provider id "${id}": use 1-64 characters of lowercase letters, digits, dash or underscore ` +
        "(it becomes a TOML key and a model-string prefix)",
    )
  }
  checkProviderID(id)
  return id
}

/**
 * The environment variable names worth looking in for this provider's key.
 *
 * The provider's own variable first (so `ANTHROPIC_API_KEY` works when the provider declares it),
 * then moat's own override, then the default provider's variable. Order is precedence: explicit
 * user intent beats convention, and a configured provider beats the built-in one's name.
 */
export function providerCredentialCandidates(spec: ProviderSpec | undefined): string[] {
  const names: string[] = []
  if (spec?.envVar) names.push(spec.envVar)
  names.push("MOAT_CREDENTIAL")
  if (spec?.id !== DEEPSEEK.id) names.push(DEEPSEEK.envVar)
  return [...new Set(names)]
}
