import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"

import {
  ALPINE_ROOTFS_URL,
  ALPINE_VERSION,
  NPM_REGISTRY,
  OPENCODE_VERSION,
  PROVISION_PACKAGES,
  SANDBOX_TRIPLE,
  SANDBOX_WORKDIR,
} from "../lib/pins.ts"
import { cacheDir, envPaths, opencodeCachePath, rootfsCachePath, type EnvPaths } from "../lib/paths.ts"
import { out, run } from "../lib/shell.ts"
import * as log from "../lib/log.ts"
import { runInSandbox } from "./launcher.ts"

function tailOf(text: string, lines: number): string {
  return text.split("\n").slice(-lines).join("\n")
}

async function download(url: string, dest: string): Promise<void> {  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    log.debug(`cached: ${dest}`)
    return
  }
  const tmp = `${dest}.part`
  log.step(`downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`download failed: ${response.status} ${url}`)
  const total = Number(response.headers.get("content-length") ?? 0)
  let seen = 0
  let lastReport = 0
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  body.on("data", (chunk: Buffer) => {
    seen += chunk.length
    const now = Date.now()
    if (now - lastReport > 1500) {
      lastReport = now
      const pct = total ? ` (${((seen / total) * 100).toFixed(0)}%)` : ""
      log.debug(`  ${(seen / 1024 / 1024).toFixed(1)} MiB${pct}`)
    }
  })
  await pipeline(body, fs.createWriteStream(tmp))
  fs.renameSync(tmp, dest)
}

export async function ensureRootfsTarball(): Promise<string> {
  const dest = path.join(rootfsCachePath(), `alpine-${ALPINE_VERSION}-x86_64.tar.gz`)
  await download(ALPINE_ROOTFS_URL, dest)
  return dest
}

/**
 * The opencode binary itself, fetched from the npm registry and cached on the
 * host. It is a *binary*, not a credential: it is copied into the rootfs as
 * part of the image, and the image contains no key material.
 */
export async function ensureOpencodeBinary(triple = SANDBOX_TRIPLE): Promise<string> {
  const dest = opencodeCachePath(triple)
  if (fs.existsSync(dest)) return dest
  const pkg = `opencode-${triple}`
  const url = `${NPM_REGISTRY}/${pkg}/-/${pkg}-${OPENCODE_VERSION}.tgz`
  const tarball = path.join(path.dirname(dest), `${pkg}-${OPENCODE_VERSION}.tgz`)
  await download(url, tarball)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  // Stream the single member straight to disk: the binary is ~195 MiB and must
  // never pass through a utf8-decoding string buffer.
  const fd = fs.openSync(tmp, "w")
  try {
    const result = spawnSync("tar", ["-xzOf", tarball, "package/bin/opencode"], {
      stdio: ["ignore", fd, "inherit"],
    })
    if (result.status !== 0) throw new Error(`failed to extract opencode binary from ${tarball}`)
  } finally {
    fs.closeSync(fd)
  }
  fs.chmodSync(tmp, 0o755)
  fs.renameSync(tmp, dest)
  return dest
}

export function extractRootfs(tarball: string, rootfs: string): void {
  fs.mkdirSync(rootfs, { recursive: true })
  const result = spawnSync("tar", ["-xzf", tarball, "-C", rootfs], { stdio: ["ignore", "ignore", "pipe"] })
  if (result.status !== 0) {
    throw new Error(`rootfs extraction failed: ${result.stderr?.toString() ?? "unknown error"}`)
  }
}

/**
 * Host-side cache of a fully provisioned *image*.
 *
 * Provisioning is the only step that needs the network (it runs `apk add`
 * inside a sandbox boot), and the Alpine CDN is intermittently degraded on this
 * host: a cold start has been measured anywhere from 7.8s to 927s depending
 * entirely on the mirror. Caching the provisioned image decouples creating a new
 * environment from the mirror's mood.
 *
 * The cached artefact contains the packages, the pinned opencode binary and the
 * bundle. It contains no credential (verified by grepping the image) and no
 * project (excluded, like snapshots). `--fresh` bypasses it.
 */
const IMAGE_EXCLUDES = ["./work", "./proc", "./sys", "./dev", "./tmp", "./run", "./.moat", "./var/log/moat"]

export function imageCachePath(packages: string[] = PROVISION_PACKAGES): string {
  const key = crypto
    .createHash("sha256")
    .update(`${ALPINE_VERSION}|${OPENCODE_VERSION}|${SANDBOX_TRIPLE}|${[...packages].sort().join(",")}`)
    .digest("hex")
    .slice(0, 12)
  return path.join(cacheDir(), "images", `alpine-${ALPINE_VERSION}-${key}.tar.gz`)
}

export type ProvisionStep = { name: string; ms: number }

export type ProvisionResult = {
  steps: ProvisionStep[]
  totalMs: number
  /** true when the image came from the host cache instead of a network install */
  fromImageCache: boolean
  imageCache: string
  /** Every package the image is expected to contain. */
  packages: string[]
}

/**
 * Build the sandbox image for an environment.
 *
 * Order matters: the Alpine rootfs is unpacked on the host (no privileges
 * needed), then the *only* privileged-looking step, `apk add`, runs inside a
 * real sandbox boot, so it exercises exactly the same isolation the agent will.
 */
export async function provisionEnv(
  p: EnvPaths,
  opts: { useImageCache?: boolean; packages?: string[] } = {},
): Promise<ProvisionResult> {
  const packages = opts.packages ?? [...PROVISION_PACKAGES]
  const started = Date.now()
  const steps: ProvisionStep[] = []
  const mark = (name: string, from: number) => {
    const entry = { name, ms: Date.now() - from }
    steps.push(entry)
    log.debug(`  ${name}: ${entry.ms}ms`)
    return Date.now()
  }

  const imageCache = imageCachePath(packages)
  const useImageCache = opts.useImageCache !== false

  if (useImageCache && fs.existsSync(imageCache)) {
    log.step(`provisioning from the cached image ${path.basename(imageCache)}`)
    let t = Date.now()
    fs.rmSync(p.rootfs, { recursive: true, force: true })
    fs.mkdirSync(p.rootfs, { recursive: true })
    extractRootfs(imageCache, p.rootfs)
    mkdirsForRootfs(p.rootfs)
    fs.rmSync(path.join(p.rootfs, "var/log/moat"), { recursive: true, force: true })
    fs.mkdirSync(path.join(p.rootfs, "var/log/moat"), { recursive: true })
    t = mark("extract cached image", t)
    return { steps, totalMs: Date.now() - started, fromImageCache: true, imageCache, packages }
  }

  let t = Date.now()
  const tarball = await ensureRootfsTarball()
  t = mark("download rootfs", t)

  fs.rmSync(p.rootfs, { recursive: true, force: true })
  extractRootfs(tarball, p.rootfs)
  t = mark("extract rootfs", t)

  mkdirsForRootfs(p.rootfs)

  const inner = `#!/bin/sh
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Provisioning robustness, learned the hard way on this host.
#
# The Alpine CDN intermittently answers "temporary error (try again later)" for
# one repository index. When that happens mid-transaction, apk can exit non-zero
# even though every package we asked for landed correctly (it counts the
# failed *reinstall* of an already-present dependency as an error). So the
# success criterion here is not apk's exit code: it is whether the required
# toolchain is actually present, checked with apk info -e. Mirrors are rotated
# and the index is only accepted if both repositories came back clean.
packages="${packages.join(" ")}"
mirrors="https://dl-cdn.alpinelinux.org/alpine https://mirror.leaseweb.com/alpine https://uk.alpinelinux.org/alpine http://dl-cdn.alpinelinux.org/alpine"
attempt=0
ok=0
for base in $mirrors $mirrors; do
  attempt=$((attempt + 1))
  rm -rf /var/cache/apk/*
  printf '%s/v3.21/main\\n%s/v3.21/community\\n' "$base" "$base" > /etc/apk/repositories
  echo "[moat] apk attempt $attempt via $base"
  if ! apk update >/tmp/apk-update.log 2>&1; then
    echo "[moat] apk update failed"; sleep 3; continue
  fi
  if grep -q 'temporary error' /tmp/apk-update.log; then
    echo "[moat] repository index incomplete; rotating mirror"; sleep 3; continue
  fi
  apk add $packages >/tmp/apk-add.log 2>&1 || true
  missing=""
  for pkg in $packages; do
    apk info -e "$pkg" >/dev/null 2>&1 || missing="$missing $pkg"
  done
  if [ -z "$missing" ]; then
    ok=1
    echo "[moat] provisioned on attempt $attempt via $base"
    break
  fi
  echo "[moat] still missing:$missing"; sleep 3
done
if [ "$ok" != "1" ]; then
  echo "[moat] provisioning failed after $attempt attempts" >&2
  tail -6 /tmp/apk-add.log >&2 2>/dev/null || true
  exit 1
fi
for pkg in $packages; do echo "[moat] verified $pkg $(apk info -v "$pkg" 2>/dev/null | head -1)"; done
rm -rf /var/cache/apk/*
`
  const result = await runInSandbox(p, inner, { onOutput: (c) => log.debug(c.trimEnd()) })
  if (result.code !== 0) {
    throw new Error(`rootfs provisioning failed (exit ${result.code}):\n${tailOf(result.output, 25)}`)
  }
  t = mark("apk packages", t)

  const binary = await ensureOpencodeBinary()
  const target = path.join(p.rootfs, "usr/local/bin/opencode")
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(binary, target)
  fs.chmodSync(target, 0o755)
  t = mark("install opencode", t)

  // The bundle is NOT baked into the image: `moat up` renders and installs it on
  // every boot, so there is exactly one place that decides the config and a
  // cached image can never serve a stale policy.
  fs.mkdirSync(path.join(p.rootfs, "var/log/moat"), { recursive: true })
  fs.mkdirSync(p.work, { recursive: true })
  fs.mkdirSync(p.snapshots, { recursive: true })
  fs.mkdirSync(p.logs, { recursive: true })

  // Save the finished image for the next environment, so the mirror is a
  // one-time dependency per (alpine, opencode, package-set) combination.
  t = Date.now()
  try {
    await saveImage(p, imageCache)
    t = mark("cache image", t)
  } catch (error) {
    log.warn(`could not cache the provisioned image: ${(error as Error).message}`)
  }

  return { steps, totalMs: Date.now() - started, fromImageCache: false, imageCache, packages }
}

/**
 * Install packages into an existing environment, incrementally.
 *
 * Only the missing ones are fetched, so `moat up --profile python` on an
 * environment that already exists costs one boot plus the packages it does not
 * have. Returns the packages that were actually installed.
 */
/**
 * Paths that are never part of a snapshot: the project, and the pseudo-filesystems.
 */
const SNAPSHOT_EXCLUDES = ["./work", "./proc", "./sys", "./dev", "./tmp", "./run", "./.moat"]

/**
 * Snapshot names become filenames under envs/<id>/snapshots. A name from the
 * command line must not be able to leave that directory, so it is validated
 * before it is joined into a path anywhere.
 */
const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function validateSnapshotName(name: string): string {
  if (!SNAPSHOT_NAME.test(name)) {
    throw new Error(
      `invalid snapshot name "${name}": use 1-64 characters of letters, digits, dot, dash or underscore, ` +
        "starting with a letter or digit",
    )
  }
  return name
}

/** Directories and files every rootfs needs, plus moat's own sandbox git identity. */
function mkdirsForRootfs(rootfs: string): void {
  for (const dir of [
    "etc",
    "proc",
    "sys",
    "dev",
    "tmp",
    "run",
    "work",
    "var/log/moat",
    "usr/local/bin",
    ".moat",
    "root/.config/opencode",
  ]) {
    fs.mkdirSync(path.join(rootfs, dir), { recursive: true })
  }
  fs.writeFileSync(path.join(rootfs, "etc/hosts"), "127.0.0.1 localhost\n::1 localhost\n")
  fs.chmodSync(path.join(rootfs, "tmp"), 0o1777)

  // A sandbox-owned git identity. Written as a file on the host, which needs no
  // privileges, and baked into the image so it survives across boots and across
  // environments. The host's ~/.gitconfig is never read or copied, that is the
  // point: the agent's commits are attributable to moat, not to the user.
  fs.mkdirSync(path.join(rootfs, "root"), { recursive: true })
  fs.writeFileSync(
    path.join(rootfs, "root/.gitconfig"),
    [
      "[user]",
      "\tname = moat agent",
      "\temail = agent@moat.invalid",
      "[init]",
      "\tdefaultBranch = main",
      "[advice]",
      "\tdetachedHead = false",
      "[safe]",
      `\tdirectory = ${SANDBOX_WORKDIR}`,
      "",
    ].join("\n"),
  )
}

/** Freeze a provisioned rootfs into the host image cache. */
async function saveImage(p: EnvPaths, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  const args = ["-czf", tmp, "-C", p.rootfs]
  for (const exclude of IMAGE_EXCLUDES) args.push(`--exclude=${exclude}`)
  args.push(".")
  await run("tar", args)
  fs.renameSync(tmp, dest)
}

export async function ensurePackages(
  p: EnvPaths,
  packages: string[],
  opts: { post?: string[]; onOutput?: (chunk: string) => void } = {},
): Promise<{ installed: string[]; alreadyPresent: string[] }> {
  const post = (opts.post ?? []).join("\n")
  const script = `#!/bin/sh
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
wanted="${packages.join(" ")}"
missing=""
present=""
for pkg in $wanted; do
  if apk info -e "$pkg" >/dev/null 2>&1; then present="$present $pkg"; else missing="$missing $pkg"; fi
done
echo "[moat] already present:$present"
if [ -z "$missing" ]; then
  echo "[moat] nothing to install"
  echo "[moat] MOAT_PRESENT:$present"
  echo "[moat] MOAT_INSTALLED:"
  exit 0
fi
toinstall="$missing"
echo "[moat] installing:$toinstall"
mirrors="https://dl-cdn.alpinelinux.org/alpine https://mirror.leaseweb.com/alpine https://uk.alpinelinux.org/alpine http://dl-cdn.alpinelinux.org/alpine"
attempt=0
ok=0
for base in $mirrors $mirrors; do
  attempt=$((attempt + 1))
  rm -rf /var/cache/apk/*
  printf '%s/v3.21/main\\n%s/v3.21/community\\n' "$base" "$base" > /etc/apk/repositories
  if ! apk update >/tmp/apk-update.log 2>&1; then sleep 3; continue; fi
  if grep -q 'temporary error' /tmp/apk-update.log; then sleep 3; continue; fi
  apk add $missing >/tmp/apk-add.log 2>&1 || true
  still=""
  for pkg in $missing; do apk info -e "$pkg" >/dev/null 2>&1 || still="$still $pkg"; done
  if [ -z "$still" ]; then ok=1; echo "[moat] installed on attempt $attempt via $base"; break; fi
  missing="$still"
  sleep 3
done
if [ "$ok" != "1" ]; then
  echo "[moat] could not install:$missing" >&2
  tail -8 /tmp/apk-add.log >&2 2>/dev/null || true
  exit 1
fi
rm -rf /var/cache/apk/*
${post}
echo "[moat] MOAT_PRESENT:$present"
echo "[moat] MOAT_INSTALLED:$toinstall"
`
  const result = await runInSandbox(p, script, { onOutput: opts.onOutput })
  if (result.code !== 0) {
    throw new Error(`package installation failed (exit ${result.code}):\n${tailOf(result.output, 20)}`)
  }
  const list = (marker: string): string[] => {
    const match = new RegExp(`\\[moat\\] ${marker}:(.*)`).exec(result.output)
    return (match?.[1] ?? "").trim().split(/\s+/).filter(Boolean)
  }
  return { installed: list("MOAT_INSTALLED"), alreadyPresent: list("MOAT_PRESENT") }
}

export async function snapshotEnv(p: EnvPaths, name: string): Promise<{ file: string; bytes: number }> {
  const valid = validateSnapshotName(name)
  fs.mkdirSync(p.snapshots, { recursive: true })
  const file = path.join(p.snapshots, `${valid}.tar.gz`)
  // Write beside the target and rename, so a failed or interrupted tar never
  // leaves a half-written snapshot that looks usable.
  const tmp = `${file}.part`
  const args = ["-czf", tmp, "-C", p.rootfs]
  for (const exclude of SNAPSHOT_EXCLUDES) args.push(`--exclude=${exclude}`)
  args.push(".")
  try {
    await run("tar", args)
    fs.renameSync(tmp, file)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
  return { file, bytes: fs.statSync(file).size }
}

/**
 * Restore a snapshot over the rootfs, preserving the project copy.
 *
 * The old version deleted the live rootfs and only then unpacked the snapshot,
 * so a failed or partial extraction destroyed the environment with nothing to
 * roll back to. This extracts beside the rootfs first, moves /work across (both
 * on the same filesystem, so it is a rename), and swaps with renames. If the
 * swap fails, the previous rootfs and the project are put back.
 */
export async function restoreEnv(p: EnvPaths, name: string): Promise<void> {
  const valid = validateSnapshotName(name)
  const file = path.join(p.snapshots, `${valid}.tar.gz`)
  if (!fs.existsSync(file)) throw new Error(`no such snapshot: ${name}`)

  const staging = path.join(p.dir, `rootfs.restore-${process.pid}`)
  const previous = path.join(p.dir, `rootfs.previous-${process.pid}`)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.rmSync(previous, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })

  let workMoved = false
  try {
    await run("tar", ["-xzf", file, "-C", staging])
    mkdirsForRootfs(staging)

    // The project is not in the snapshot; carry the live one into the new image.
    const liveWork = path.join(p.rootfs, "work")
    if (fs.existsSync(liveWork)) {
      fs.rmSync(path.join(staging, "work"), { recursive: true, force: true })
      fs.renameSync(liveWork, path.join(staging, "work"))
      workMoved = true
    }

    fs.renameSync(p.rootfs, previous)
    try {
      fs.renameSync(staging, p.rootfs)
    } catch (error) {
      fs.renameSync(previous, p.rootfs)
      throw error
    }
    fs.rmSync(previous, { recursive: true, force: true })
  } catch (error) {
    if (workMoved) {
      try {
        fs.renameSync(path.join(staging, "work"), path.join(p.rootfs, "work"))
      } catch {
        /* the live work is already back if the swap never started */
      }
    }
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

export function destroyEnv(projectDir: string): boolean {
  const p = envPaths(projectDir)
  if (!fs.existsSync(p.dir)) return false
  fs.rmSync(p.dir, { recursive: true, force: true })
  return true
}

export async function listSnapshots(p: EnvPaths): Promise<{ name: string; bytes: number; mtime: string }[]> {
  if (!fs.existsSync(p.snapshots)) return []
  return fs
    .readdirSync(p.snapshots)
    .filter((f) => f.endsWith(".tar.gz") && SNAPSHOT_NAME.test(f.replace(/\.tar\.gz$/, "")))
    .map((f) => {
      const stat = fs.statSync(path.join(p.snapshots, f))
      return { name: f.replace(/\.tar\.gz$/, ""), bytes: stat.size, mtime: stat.mtime.toISOString() }
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
}

export async function rootfsSizeBytes(p: EnvPaths): Promise<number> {
  const result = await out("du", ["-sb", p.rootfs], { allowFailure: true }).catch(() => "0")
  return Number.parseInt(result.split(/\s+/)[0] ?? "0", 10) || 0
}

/**
 * The baseline snapshot: the image the environment was provisioned from.
 *
 * When provisioning came from the host image cache, the cache file *is* the
 * baseline, so a symlink is enough, compressing a second 107 MiB copy would add
 * seconds to every cold start for no benefit.
 */
export function baselineSnapshot(p: EnvPaths, provision: ProvisionResult): { bytes: number; linked: boolean } {
  fs.mkdirSync(p.snapshots, { recursive: true })
  const dest = path.join(p.snapshots, "baseline.tar.gz")
  fs.rmSync(dest, { force: true })
  if (provision.fromImageCache) {
    try {
      fs.symlinkSync(provision.imageCache, dest)
      return { bytes: fs.statSync(dest).size, linked: true }
    } catch {
      /* fall through to a real copy */
    }
  }
  const args = ["-czf", dest, "-C", p.rootfs]
  for (const exclude of SNAPSHOT_EXCLUDES) args.push(`--exclude=${exclude}`)
  args.push(".")
  const result = spawnSync("tar", args, { stdio: ["ignore", "ignore", "pipe"] })
  if (result.status !== 0) throw new Error(`baseline snapshot failed: ${result.stderr?.toString() ?? ""}`)
  return { bytes: fs.statSync(dest).size, linked: false }
}
