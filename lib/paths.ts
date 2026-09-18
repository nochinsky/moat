import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { OPENCODE_VERSION } from "./pins.ts"

/** Root of all moat state. Overridable for tests so they never touch the real store. */
export function moatHome(): string {
  return process.env.MOAT_HOME || path.join(os.homedir(), ".moat")
}

export function cacheDir(): string {
  return path.join(moatHome(), "cache")
}

export function envsDir(): string {
  return path.join(moatHome(), "envs")
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

export function envPaths(projectDir: string): EnvPaths {
  const id = projectId(projectDir)
  const dir = path.join(envsDir(), id)
  const rootfs = path.join(dir, "rootfs")
  return {
    id,
    projectDir: fs.realpathSync(path.resolve(projectDir)),
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

export function rootfsCachePath(): string {
  return path.join(cacheDir(), "rootfs")
}

/** Host-side cache of an opencode binary, keyed by version + triple. */
export function opencodeCachePath(triple: string): string {
  return path.join(cacheDir(), "opencode", OPENCODE_VERSION, triple, "opencode")
}
