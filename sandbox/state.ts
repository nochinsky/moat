import fs from "node:fs"
import path from "node:path"

import { envPaths, envsDir, type EnvPaths } from "../lib/paths.ts"

export type EnvStatus = "provisioning" | "stopped" | "running"

export type CredentialRecord = {
  provider: string
  /** Only the fingerprint is persisted. The value never touches this file. */
  fingerprint: string
  mintedAt: string
  expiresAt: string
}

export type EnvState = {
  version: 1
  id: string
  projectDir: string
  createdAt: string
  lastUpAt: string | null
  status: EnvStatus
  opencodeVersion: string
  alpineVersion: string
  /** TCP port the in-sandbox `opencode serve` is listening on (shared host netns in v0). */
  port: number | null
  /** The full `provider/model` string opencode was given. */
  model: string | null
  /** The provider's short id (`zai`, `deepseek`, `openai`, …). */
  provider: string | null
  /** Host-visible base URL of the injected provider (no credential in it). */
  providerBaseUrl: string | null
  /** Branch the agent was told to commit to. */
  branch: string | null
  /** Toolchain profiles currently installed in this environment. */
  profiles: string[]
  /** PID of the namespace supervisor process group leader on the host. */
  pid: number | null
  /** Tree digest of the host project as of the last copy-in. */
  baselineDigest: string | null
  /** Fingerprint of the host project at copy-in time, to detect that it moved on. */
  baselineHostState: string | null
  credential: CredentialRecord | null
  snapshots: string[]
  /** Every boot records its measured cold-start breakdown for the record. */
  lastBootMs: number | null
}

export function initialState(p: EnvPaths, versions: { opencode: string; alpine: string }): EnvState {
  return {
    version: 1,
    id: p.id,
    projectDir: p.projectDir,
    createdAt: new Date().toISOString(),
    lastUpAt: null,
    status: "stopped",
    opencodeVersion: versions.opencode,
    alpineVersion: versions.alpine,
    port: null,
    model: null,
    provider: null,
    providerBaseUrl: null,
    branch: null,
    profiles: [],
    pid: null,
    baselineDigest: null,
    baselineHostState: null,
    credential: null,
    snapshots: [],
    lastBootMs: null,
  }
}

export function readState(p: EnvPaths): EnvState | null {
  if (!fs.existsSync(p.state)) return null
  try {
    return JSON.parse(fs.readFileSync(p.state, "utf8")) as EnvState
  } catch {
    return null
  }
}

export function writeState(p: EnvPaths, state: EnvState): void {
  fs.mkdirSync(path.dirname(p.state), { recursive: true })
  const tmp = `${p.state}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, p.state)
}

export function envExists(p: EnvPaths): boolean {
  return fs.existsSync(p.rootfs)
}

/** The per-boot server password lives outside the rootfs, readable only by the user. */
export function passwordPath(p: EnvPaths): string {
  return path.join(p.dir, "server-password")
}

export function writePassword(p: EnvPaths, password: string): void {
  fs.mkdirSync(p.dir, { recursive: true })
  fs.writeFileSync(passwordPath(p), `${password}\n`, { mode: 0o600 })
}

export function readPassword(p: EnvPaths): string | null {
  const file = passwordPath(p)
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null
}

export function listEnvs(): EnvPaths[] {
  const root = envsDir()
  if (!fs.existsSync(root)) return []
  const result: EnvPaths[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const stateFile = path.join(root, entry.name, "state.json")
    if (!fs.existsSync(stateFile)) continue
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8")) as EnvState
      result.push(envPaths(raw.projectDir))
    } catch {
      /* ignore unreadable envs */
    }
  }
  return result
}
