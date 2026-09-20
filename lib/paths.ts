import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { CODEX_VERSION, OPENCODE_VERSION, SLIRP4NETNS_VERSION } from "./pins.ts"

/** Root of all moat state. Overridable for tests so they never touch the real store. */
export function moatHome(): string {
  return process.env.MOAT_HOME || path.join(os.homedir(), ".moat")
}

/**
 * Create the state directory with mode 0700, and repair one that is group- or
 * world-accessible.
 *
 * `readStore` refuses a credentials file others can read, but that check is
 * worth nothing if another local user can replace the file: a permissive
 * directory lets them swap a credential in, which the broker would then inject.
 */
export function ensureMoatHome(): string {
  const home = moatHome()
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  try {
    const mode = fs.statSync(home).mode & 0o777
    if (mode & 0o077) fs.chmodSync(home, mode & ~0o077)
  } catch {
    /* best effort; readStore still refuses a readable credentials file */
  }
  return home
}

export function cacheDir(): string {
  return path.join(moatHome(), "cache")
}

export function envsDir(): string {
  return path.join(moatHome(), "envs")
}

/**
 * A temp path unique per process *and* per call, for write-then-rename.
 *
 * The pid alone was not enough — two concurrent writers inside one process, and
 * two host processes working on one environment, shared the same ".part"/".tmp"
 * name and the loser's rename failed with ENOENT. It is not only lost data: the
 * crash is an unhandled exception in the middle of a command that had already
 * done its work. Measured on `writeState`: three runs out of three, one of two
 * racing writers died renaming `state.json.tmp`.
 */
export function partPath(dest: string): string {
  return `${dest}.part-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
}

export function credentialsFile(): string {
  return path.join(moatHome(), "credentials.json")
}

/** Stable per-project id. Derived from the *real* path so symlinked cwd's share one env. */
export function projectId(projectDir: string): string {
  const real = fs.realpathSync(path.resolve(projectDir))
  return crypto.createHash("sha256").update(real).digest("hex").slice(0, 12)
}

export type EnvPaths = {
  id: string
  projectDir: string
  dir: string
  rootfs: string
  work: string
  /** A separate mount point that the rootfs is bound onto; keeps the persistent rootfs clean. */
  mountpoint: string
  state: string
  logs: string
  snapshots: string
  entryScript: string
  auditDir: string
}

/** A `moat logs <name>` argument: one file name inside the environment's log directory. */
export const LOG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Validate a log name before it meets `path.join`.
 *
 * `moat logs` joins argv into the environment's log directory, and argv is
 * arbitrary: measured, `moat logs ../../../../../tmp/x` printed `/tmp/x.log`, a
 * host file outside the environment entirely. Same trap as snapshot names, same
 * rule: validate first, join second.
 */
export function validateLogName(name: string): string {
  if (!LOG_NAME.test(name)) {
    throw new Error(
      `invalid log name "${name}": use 1-64 characters of letters, digits, dot, dash or underscore`,
    )
  }
  return name
}

/** What an environment directory is named: the first 12 hex of the project hash. */
export const ENV_ID = /^[0-9a-f]{12}$/

/**
 * Environment paths from an id and the project directory that was recorded.
 *
 * This is the filesystem-free half of `envPaths`, and inventory code has to use
 * it: `envPaths` resolves the real path of the project directory, which *throws*
 * when that directory no longer exists — and an environment whose project is gone
 * is exactly the one that has to stay visible and deletable.
 */
export function envPathsForId(id: string, projectDir: string): EnvPaths {
  const dir = path.join(envsDir(), id)
  const rootfs = path.join(dir, "rootfs")
  return {
    id,
    projectDir,
    dir,
    rootfs,
    work: path.join(rootfs, "work"),
    mountpoint: path.join(dir, "mnt"),
    state: path.join(dir, "state.json"),
    logs: path.join(dir, "logs"),
    snapshots: path.join(dir, "snapshots"),
    entryScript: path.join(rootfs, ".moat", "entry.sh"),
    auditDir: path.join(rootfs, "var", "log", "moat"),
  }
}

export function envPaths(projectDir: string): EnvPaths {
  const real = fs.realpathSync(path.resolve(projectDir))
  return envPathsForId(projectId(real), real)
}

export function rootfsCachePath(): string {
  return path.join(cacheDir(), "rootfs")
}

/** Host-side cache of the static slirp4netns used for an isolated sandbox netns. */
export function slirpCachePath(): string {
  return path.join(cacheDir(), "net", `slirp4netns-${SLIRP4NETNS_VERSION}`)
}

/** Host-side cache of an opencode binary, keyed by version + triple. */
export function opencodeCachePath(triple: string): string {
  return path.join(cacheDir(), "opencode", OPENCODE_VERSION, triple, "opencode")
}

/** Host-side cache of a Codex CLI binary, keyed by version + platform package. */
export function codexCachePath(triple: string): string {
  return path.join(cacheDir(), "codex", CODEX_VERSION, triple, "codex")
}
