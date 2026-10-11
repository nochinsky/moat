import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { PI_CLI, PI_INSTALL_DIR, PI_LOCK_SHA256, PI_VERSION, RUNTIME_BINARY, SANDBOX_TRIPLE } from "../lib/pins.ts"
import { partPath, piCachePath, type EnvPaths } from "../lib/paths.ts"
import { ensureRootfsDir, readRootfsFile, replaceRootfsDir, writeRootfsFile } from "../lib/rootfs-fs.ts"
import { download, verifyFile } from "./rootfs.ts"
import * as log from "../lib/log.ts"

export const PI_INSTALL_MARKER = `${PI_INSTALL_DIR}/moat-lock.sha256`
export const PI_WRAPPER = `#!/bin/sh\nexec /usr/bin/node ${PI_CLI} "$@"\n`

type LockedPackage = {
  version?: string
  resolved?: string
  integrity?: string
  os?: string[]
  cpu?: string[]
  libc?: string[]
}

function allowed(list: string[] | undefined, value: string): boolean {
  return !list || (!list.includes(`!${value}`) && (list.every((v) => v.startsWith("!")) || list.includes(value)))
}

/** Verify the graph before using its URLs, including on a cache hit. No npm code runs on the host. */
export function piDependencyGraph(lockText: string): [string, LockedPackage][] {
  if (crypto.createHash("sha256").update(lockText).digest("hex") !== PI_LOCK_SHA256) {
    throw new Error("Pi dependency lock does not match PI_LOCK_SHA256; refusing the runtime")
  }
  const lock = JSON.parse(lockText) as { packages: Record<string, LockedPackage> }
  if (lock.packages["node_modules/@earendil-works/pi-coding-agent"]?.version !== PI_VERSION) {
    throw new Error("Pi version and dependency lock disagree")
  }
  return Object.entries(lock.packages).filter(([name, pkg]) => {
    if (name === "") return false
    if (!/^node_modules\/(?:[^/]+\/)*[^/]+$/.test(name) || name.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`invalid locked Pi package path: ${name}`)
    }
    if (!pkg.resolved?.startsWith("https://registry.npmjs.org/") || !pkg.integrity?.startsWith("sha512-")) {
      throw new Error(`Pi package has no pinned registry artifact: ${name}`)
    }
    return allowed(pkg.os, "linux") && allowed(pkg.cpu, "x64") && allowed(pkg.libc, "musl")
  })
}

/** Assemble only digest-verified packages. Do not execute dependency installation scripts. */
export async function ensurePiArchive(triple = SANDBOX_TRIPLE): Promise<string> {
  if (triple !== "linux-x64-musl") throw new Error(`Pi is not pinned for the ${triple} sandbox triple`)
  // copy-assets preserves this directory beside the compiled module, including in npm installs.
  const assets = fileURLToPath(new URL("../bundle/pi-runtime/", import.meta.url))
  const graph = piDependencyGraph(fs.readFileSync(path.join(assets, "package-lock.json"), "utf8"))
  const cache = piCachePath()
  fs.mkdirSync(cache, { recursive: true })
  const archive = path.join(cache, "runtime.tar.gz")
  const sidecar = `${archive}.sha256`
  if (fs.existsSync(archive) && fs.existsSync(sidecar)) {
    const digest = fs.readFileSync(sidecar, "utf8").trim()
    if (/^[0-9a-f]{64}$/.test(digest) && await verifyFile(archive, { sha256: digest })) return archive
  }
  const tree = fs.mkdtempSync(path.join(cache, "build-"))
  const temp = partPath(archive)
  try {
    fs.copyFileSync(path.join(assets, "package.json"), path.join(tree, "package.json"))
    fs.copyFileSync(path.join(assets, "package-lock.json"), path.join(tree, "package-lock.json"))
    let next = 0
    const downloads = await Promise.allSettled(Array.from({ length: Math.min(6, graph.length) }, async () => {
      for (;;) {
        const item = graph[next++]
        if (!item) break
        const [name, pkg] = item
        const artifact = path.join(cache, "artifacts", crypto.createHash("sha256").update(pkg.integrity!).digest("hex") + ".tgz")
        await download(pkg.resolved!, artifact, { integrity: pkg.integrity! })
        const dest = path.join(tree, name)
        fs.mkdirSync(dest, { recursive: true })
        const result = spawnSync("tar", ["-xzf", artifact, "--strip-components=1", "-C", dest], { stdio: ["ignore", "ignore", "pipe"] })
        if (result.status !== 0) throw new Error(`cannot unpack Pi package ${name}: ${result.stderr?.toString()}`)
      }
    }))
    // Reap every worker before deleting the staging tree on a failure.
    for (const result of downloads) if (result.status === "rejected") throw result.reason
    fs.writeFileSync(path.join(tree, "moat-lock.sha256"), PI_LOCK_SHA256 + "\n")
    const result = spawnSync("tar", ["-czf", temp, "-C", tree, "."], { stdio: ["ignore", "ignore", "pipe"] })
    if (result.status !== 0) throw new Error(`cannot archive Pi: ${result.stderr?.toString()}`)
    const hash = crypto.createHash("sha256")
    for await (const bytes of fs.createReadStream(temp)) hash.update(bytes)
    const digest = hash.digest("hex")
    fs.renameSync(temp, archive)
    const sideTemp = partPath(sidecar)
    fs.writeFileSync(sideTemp, digest + "\n")
    fs.renameSync(sideTemp, sidecar)
    return archive
  } finally {
    fs.rmSync(tree, { recursive: true, force: true })
    fs.rmSync(temp, { force: true })
  }
}

export function nodeSupportsPi(p: EnvPaths): boolean {
  if (!fs.existsSync(path.join(p.rootfs, "usr/bin/node"))) return false
  // Inspect package metadata, never execute an agent-owned binary on the host. Older images can
  // have Node installed already; apk's presence check alone would leave an incompatible version.
  const db = readRootfsFile(p.rootfs, "/lib/apk/db/installed", { maxBytes: 16 * 1024 * 1024 }) ?? ""
  const entry = db.split("\n\n").find(pkg => /^P:nodejs$/m.test(pkg))
  const version = entry?.match(/^V:(\d+)\.(\d+)\./m)
  return !!version && (Number(version[1]) > 22 || (Number(version[1]) === 22 && Number(version[2]) >= 19))
}

export function runtimeNeedsRepair(p: EnvPaths): boolean {
  return readRootfsFile(p.rootfs, PI_INSTALL_MARKER, { maxBytes: 1024 })?.trim() !== PI_LOCK_SHA256
    || readRootfsFile(p.rootfs, RUNTIME_BINARY, { maxBytes: 4096 }) !== PI_WRAPPER
    || readRootfsFile(p.rootfs, PI_CLI, { maxBytes: 1024 * 1024 }) === null
    || !nodeSupportsPi(p)
}

/** Repair/upgrade in place; never provision over /work. Guard destinations BEFORE downloading. */
export async function installRuntimeBinary(p: EnvPaths): Promise<void> {
  ensureRootfsDir(p.rootfs, PI_INSTALL_DIR)
  ensureRootfsDir(p.rootfs, path.posix.dirname(RUNTIME_BINARY))
  const archive = await ensurePiArchive()
  // The agent cannot reach this host-owned staging directory. Never extract into a mutable
  // rootfs path; install the finished tree through the rootfs guard's held parent descriptor.
  const stage = fs.mkdtempSync(path.join(p.dir, ".pi-stage-"))
  try {
    const result = spawnSync("tar", ["-xzf", archive, "-C", stage], { stdio: ["ignore", "ignore", "pipe"] })
    if (result.status !== 0) throw new Error(`Pi installation failed: ${result.stderr?.toString()}`)
    replaceRootfsDir(p.rootfs, PI_INSTALL_DIR, stage, () => writeRootfsFile(p.rootfs, RUNTIME_BINARY, PI_WRAPPER, 0o755))
    log.debug(`installed Pi ${PI_VERSION} (${PI_LOCK_SHA256.slice(0, 12)})`)
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}
