import fs from "node:fs"
import path from "node:path"

import { ENV_ID, envPathsForId, envsDir, partPath, type EnvPaths } from "../lib/paths.ts"
import type { EgressMode } from "../lib/pins.ts"
import { DEEPSEEK } from "../lib/provider.ts"

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
  /**
   * Reasoning effort for that model (`off`, `low`, `high`, `max`), or null for
   * the built-in default.
   *
   * This is opencode's "variant": sent as `reasoning_effort` on the request, or
   * as `thinking: {type: disabled}` for `off`. Not every model accepts every
   * level, so it is stored per environment next to the model it was chosen for,
   * and it is checked against that model's levels before it is sent.
   */
  effort: string | null
  /** Named opencode agent the session defaults to (`build`, `plan`, …), if chosen. */
  agent: string | null
  /** The provider's short id (`zai`, `deepseek`, `openai`, …). */
  provider: string | null
  /** Host-visible base URL of the injected provider (no credential in it). */
  providerBaseUrl: string | null
  /** Branch the agent was told to commit to. */
  branch: string | null
  /** The branch that was checked out when the agent's branch was created. */
  baseBranch: string | null
  /** Toolchain profiles currently installed in this environment. */
  profiles: string[]
  /** PID of the namespace supervisor process group leader on the host. */
  pid: number | null
  /**
   * /proc/<pid>/stat starttime recorded when the sandbox was spawned.
   *
   * A pid alone is not an identity: after a reboot, or after the process died
   * and the number was reused, `moat down` would otherwise signal a bystander's
   * process group. Kept next to the pid it identifies.
   */
  pidStart: string | null
  /** How much network the environment gets: the host's namespace, or its own. */
  egress: EgressMode
  /** Extra hosts the filtered allowlist permits, beyond the defaults. */
  egressAllow: string[]
  /** slirp4netns pid for an isolated environment, and its identity. */
  slirpPid: number | null
  slirpStart: string | null
  /** Tree digest of the host project as of the last copy-in. */
  baselineDigest: string | null
  /** Fingerprint of the host project at copy-in time, to detect that it moved on. */
  baselineHostState: string | null
  /** Commit in the sandbox repository holding exactly what was copied. */
  baselineCommit: string | null
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
    effort: DEEPSEEK.defaultEffort,
    agent: null,
    provider: null,
    providerBaseUrl: null,
    branch: null,
    baseBranch: null,
    profiles: [],
    pid: null,
    pidStart: null,
    // A placeholder until `moat up` resolves the policy (filtered by default,
    // open for a loopback provider) and records it before the first boot.
    egress: "open",
    egressAllow: [],
    slirpPid: null,
    slirpStart: null,
    baselineDigest: null,
    baselineHostState: null,
    baselineCommit: null,
    credential: null,
    snapshots: [],
    lastBootMs: null,
  }
}

/** What can be rebuilt about an environment whose state.json is gone. */
export type RecoveredStateFields = {
  /** Branch the sandbox repository has checked out, or null when detached. */
  branch: string | null
  /** Commit holding exactly what was copied in, from `refs/moat/baseline`. */
  baselineCommit: string | null
  /** `/etc/alpine-release`, when the rootfs still says. */
  alpineVersion: string | null
  /** Best effort: the environment directory's own birth time. */
  createdAt: string | null
}

/**
 * An environment's state, rebuilt from what survives in its directory.
 *
 * `state.json` is metadata; the environment is the rootfs. Reading a missing
 * state as "there is nothing here" is how `moat up` came to provision over a
 * rootfs holding a committed agent branch and an untracked file, destroying
 * both without a word (measured), which also contradicts SPEC §2.2: `moat
 * destroy` is the only operation that deletes data.
 *
 * Deliberately conservative. The credential is not carried over (the boot
 * mints a new one, and the old one is dead anyway), the recorded host
 * baseline is *not* invented (so the drift check says it cannot run rather
 * than comparing against a baseline that was never recorded), and the
 * versions are only filled in from the rootfs when the rootfs still says.
 * Everything the next boot learns — port, model, egress, profiles, the new
 * branch — overwrites the placeholder before it is persisted.
 */
export function recoveredState(p: EnvPaths, fields: RecoveredStateFields): EnvState {
  const state = initialState(p, { opencode: "unknown", alpine: fields.alpineVersion ?? "unknown" })
  if (fields.createdAt) state.createdAt = fields.createdAt
  state.branch = fields.branch
  state.baselineCommit = fields.baselineCommit
  return state
}

export function readState(p: EnvPaths): EnvState | null {
  if (!fs.existsSync(p.state)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(p.state, "utf8")) as EnvState
    // Environments written before these fields existed are otherwise valid; fill
    // them in rather than making every reader defend against undefined. An
    // environment with no recorded effort gets the default rather than "unset",
    // so it behaves the same as one created today.
    if (raw.effort === undefined) raw.effort = DEEPSEEK.defaultEffort
    if (raw.agent === undefined) raw.agent = null
    if (raw.pidStart === undefined) raw.pidStart = null
    if (raw.egress === undefined) raw.egress = "open"
    if (raw.egressAllow === undefined) raw.egressAllow = []
    if (raw.slirpPid === undefined) raw.slirpPid = null
    if (raw.slirpStart === undefined) raw.slirpStart = null
    return raw
  } catch {
    return null
  }
}

export function writeState(p: EnvPaths, state: EnvState): void {
  fs.mkdirSync(path.dirname(p.state), { recursive: true })
  // Unique per call: a fixed `state.json.tmp` collided when two host processes
  // wrote one environment's state (an `up` racing `exec`/doctor), and the loser
  // died with ENOENT on the rename above.
  const tmp = partPath(p.state)
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, p.state)
}

export function envExists(p: EnvPaths): boolean {
  return fs.existsSync(p.rootfs)
}

/**
 * Has the injected credential's TTL elapsed?
 *
 * The in-sandbox watchdog stops the agent, but the host is the party that must
 * refuse to keep driving: a box whose credential is dead cannot serve a turn,
 * and silently trying produces a confusing provider error instead.
 */
export function credentialExpired(state: EnvState, now = Date.now()): boolean {
  const expires = state.credential?.expiresAt
  if (!expires) return false
  const at = Date.parse(expires)
  return Number.isFinite(at) && at <= now
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

/** Printed when an environment's recorded project directory is not usable. */
export const PROJECT_GONE = "<the project directory this environment recorded is gone>"

/**
 * Every environment on disk.
 *
 * The *directory name* is the id, and it is authoritative. This used to rebuild
 * the paths from the project directory in state.json, through `envPaths`, which
 * resolves the real path of that directory and throws when it is gone: the env
 * was dropped by the `catch`, so `moat status --all` could not report it and
 * `moat destroy --all` could not reclaim it. Two environments holding 800 MiB
 * were invisible that way. A directory whose state cannot be read is listed too,
 * for the same reason.
 */
export function listEnvs(): EnvPaths[] {
  const root = envsDir()
  if (!fs.existsSync(root)) return []
  const result: EnvPaths[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ENV_ID.test(entry.name)) continue
    const stateFile = path.join(root, entry.name, "state.json")
    let projectDir = PROJECT_GONE
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { projectDir?: unknown }
      if (typeof raw.projectDir === "string" && raw.projectDir.length > 0) projectDir = raw.projectDir
    } catch {
      /* no readable state: still an environment directory, still holding disk */
    }
    result.push(envPathsForId(entry.name, projectDir))
  }
  return result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
