import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"

import {
  ALPINE_ROOTFS_SHA256,
  ALPINE_ROOTFS_URL,
  ALPINE_VERSION,
  CLAUDE_PLATFORM_PACKAGE,
  CLAUDE_TARBALL_PATH,
  CLAUDE_TARBALL_SHA256,
  CLAUDE_VERSION,
  CODEX_PLATFORM_PACKAGE,
  CODEX_TARBALL_SHA256,
  CODEX_VENDOR_TRIPLE,
  CODEX_VERSION,
  NPM_REGISTRY,
  PROVISION_PACKAGES,
  RUNTIME_BINARY,
  SANDBOX_TRIPLE,
  SANDBOX_WORKDIR,
} from "../lib/pins.ts"
import { cacheDir, claudeCachePath, codexCachePath, partPath, rootfsCachePath, type EnvPaths } from "../lib/paths.ts"
import { CLAUDE_BINARY, type RuntimeId } from "../lib/pins.ts"
import { chmodRootfsDir, ensureRootfsDir, writeRootfsFile } from "../lib/rootfs-fs.ts"
import { out, run } from "../lib/shell.ts"
import * as log from "../lib/log.ts"
import { runInSandbox } from "./launcher.ts"

function tailOf(text: string, lines: number): string {
  return text.split("\n").slice(-lines).join("\n")
}

export type DownloadDigest = { sha256?: string; integrity?: string }

async function hashFile(file: string, algorithm: "sha256" | "sha512", encoding: "hex" | "base64"): Promise<string> {
  const hash = crypto.createHash(algorithm)
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest(encoding)
}

/**
 * Does this file match the expected digest?
 *
 * `integrity` is an SRI string (sha512-<base64>), the shape npm publishes;
 * `sha256` is a hex digest. A file is accepted only when the published value
 * matches what is on disk.
 */
export async function verifyFile(file: string, digest: DownloadDigest): Promise<boolean> {
  if (digest.integrity) {
    if (!digest.integrity.startsWith("sha512-")) return false
    const actual = await hashFile(file, "sha512", "base64")
    return `sha512-${actual}`.toLowerCase() === digest.integrity.toLowerCase()
  }
  if (digest.sha256) {
    return (await hashFile(file, "sha256", "hex")).toLowerCase() === digest.sha256.toLowerCase()
  }
  return true
}

/**
 * Download an artefact into the host cache, verifiably and atomically.
 *
 * - the digest is checked before the file is accepted, and an already-cached
 *   file is re-checked too, so a corrupted or truncated cache entry is replaced
 *   rather than unpacked;
 * - the temporary name is unique per process and the final rename is atomic, so
 *   two concurrent moat invocations cannot interleave into one `.part` file.
 */
export async function download(url: string, dest: string, digest: DownloadDigest = {}): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    if (await verifyFile(dest, digest)) {
      log.debug(`cached: ${dest}`)
      return
    }
    log.warn(`cached file failed its digest check and will be re-downloaded: ${dest}`)
    fs.rmSync(dest, { force: true })
  }
  const tmp = partPath(dest)
  log.step(`downloading ${url}`)
  try {
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
    if (!(await verifyFile(tmp, digest))) {
      throw new Error(
        `digest mismatch for ${url}: the download does not match the pinned ` +
          `${digest.integrity ? "integrity" : "sha256"}`,
      )
    }
    fs.renameSync(tmp, dest)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

export async function ensureRootfsTarball(): Promise<string> {
  const dest = path.join(rootfsCachePath(), `alpine-${ALPINE_VERSION}-x86_64.tar.gz`)
  await download(ALPINE_ROOTFS_URL, dest, { sha256: ALPINE_ROOTFS_SHA256 })
  return dest
}

/**
 * The Codex CLI binary, fetched from the npm registry and cached on the host.
 *
 * It is a *binary*, not a credential: it is copied into the rootfs as part of the image, and
 * the image contains no key material.
 *
 * The npm platform tarball ships a **musl** build under `vendor/<triple>/bin/codex`, which
 * is why it runs on the Alpine image with no gcompat and no Node runtime: the CLI is the one
 * thing moat installs that is neither Alpine's nor the project's.
 *
 * A triple with no pinned digest is refused. An unverified binary that becomes the agent
 * runtime is the one artefact moat cannot be casual about.
 */
export async function ensureCodexBinary(triple = SANDBOX_TRIPLE): Promise<string> {
  const dest = codexCachePath(triple)
  if (fs.existsSync(dest)) return dest
  const platform = CODEX_PLATFORM_PACKAGE[triple]
  const vendor = CODEX_VENDOR_TRIPLE[triple]
  const sha256 = CODEX_TARBALL_SHA256[triple]
  if (!platform || !vendor) throw new Error(`codex is not pinned for the ${triple} sandbox triple`)
  if (!sha256) throw new Error(`codex has no pinned digest for ${triple}, so moat will not install it`)
  const pkg = `codex-${CODEX_VERSION}-${platform}`
  const url = `${NPM_REGISTRY}/@openai/codex/-/${pkg}.tgz`
  const tarball = path.join(path.dirname(dest), `${pkg}.tgz`)
  await download(url, tarball, { sha256 })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = partPath(dest)
  // Straight to disk: 269 MiB must never pass through a utf8-decoding string buffer.
  const fd = fs.openSync(tmp, "w")
  try {
    const result = spawnSync("tar", ["-xzOf", tarball, `package/vendor/${vendor}/bin/codex`], {
      stdio: ["ignore", fd, "inherit"],
    })
    if (result.status !== 0) throw new Error(`failed to extract the codex binary from ${tarball}`)
  } finally {
    fs.closeSync(fd)
  }
  fs.chmodSync(tmp, 0o755)
  fs.renameSync(tmp, dest)
  return dest
}

/**
 * The Claude Code CLI binary, fetched from the npm registry and cached on the host.
 *
 * The second agent runtime, under the same rules as the first: it is a *binary*, not a
 * credential; it is pinned by digest per platform, and a triple with no digest is refused rather
 * than downloaded unverified. Two things differ from `ensureCodexBinary` and are the whole
 * reason this is a separate function rather than a parameter: the tarball names its executable
 * at the **root** (`package/claude`) instead of under `vendor/<triple>/bin/`, and the platform
 * package carries no version in its name (`@anthropic-ai/claude-code-linux-x64-musl`), so the
 * tarball file name is `<package>-<version>.tgz`.
 */
export async function ensureClaudeBinary(triple = SANDBOX_TRIPLE): Promise<string> {
  const dest = claudeCachePath(triple)
  if (fs.existsSync(dest)) return dest
  const pkg = CLAUDE_PLATFORM_PACKAGE[triple]
  const sha256 = CLAUDE_TARBALL_SHA256[triple]
  if (!pkg) throw new Error(`claude is not pinned for the ${triple} sandbox triple`)
  if (!sha256) throw new Error(`claude has no pinned digest for ${triple}, so moat will not install it`)
  const file = `${pkg.split("/").pop()}-${CLAUDE_VERSION}.tgz`
  const url = `${NPM_REGISTRY}/${pkg}/-/${file}`
  const tarball = path.join(path.dirname(dest), file)
  await download(url, tarball, { sha256 })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = partPath(dest)
  // Straight to disk: 228 MiB must never pass through a utf8-decoding string buffer.
  const fd = fs.openSync(tmp, "w")
  try {
    const result = spawnSync("tar", ["-xzOf", tarball, CLAUDE_TARBALL_PATH], { stdio: ["ignore", fd, "inherit"] })
    if (result.status !== 0) throw new Error(`failed to extract the claude binary from ${tarball}`)
  } finally {
    fs.closeSync(fd)
  }
  fs.chmodSync(tmp, 0o755)
  fs.renameSync(tmp, dest)
  return dest
}

/**
 * Put the runtime binary into an existing rootfs, without re-provisioning.
 *
 * The agent is root inside its box, so the binary can simply be gone: deleted by the agent, or
 * never there because the image was built by an older moat. Re-provisioning is **not** an
 * option — it deletes the rootfs first, taking \`/work\`, the agent's uncommitted work, with it.
 *
 * The destination is inside the agent-writable rootfs, so this goes through the same guard as
 * every other host-side write there: a symlinked component is refused rather than followed,
 * and the copy lands on a temp name that is renamed into place. The box must not be running;
 * callers stop it first (a running box has the old binary open anyway).
 */
/**
 * Which binary belongs to which runtime, and where it lands in the rootfs.
 *
 * One place, so the image cache key, the provisioner and the repair path cannot disagree about
 * what a `claude` environment is supposed to contain — the shape of the bug that once handed an
 * environment an image with no runtime in it at all.
 */
export function runtimeBinaryPath(id: RuntimeId): string {
  return id === "claude" ? CLAUDE_BINARY : RUNTIME_BINARY
}

/**
 * The runtime's pinned version, as it appears in the image cache key.
 *
 * Codex's value is the bare version, unchanged from before the second runtime existed, so a
 * cached image is not invalidated by this refactor — the key for a codex environment is byte for
 * byte what it was.
 */
export function runtimeCacheKey(id: RuntimeId): string {
  return id === "claude" ? `claude-${CLAUDE_VERSION}` : CODEX_VERSION
}

/** The host-side cache for a runtime's binary, fetched and digest-verified if it is not there. */
export async function ensureRuntimeBinary(id: RuntimeId, triple = SANDBOX_TRIPLE): Promise<string> {
  return id === "claude" ? await ensureClaudeBinary(triple) : await ensureCodexBinary(triple)
}

export async function installRuntimeBinary(p: EnvPaths, id: RuntimeId = "codex"): Promise<void> {
  const target = runtimeBinaryPath(id)
  // Guard first, so a planted symlink fails before anything is downloaded or copied.
  ensureRootfsDir(p.rootfs, path.posix.dirname(target))
  const source = await ensureRuntimeBinary(id)
  const dest = path.join(p.rootfs, target.slice(1))
  const tmp = partPath(dest)
  try {
    fs.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(tmp, 0o755)
    fs.renameSync(tmp, dest)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
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
 * The cached artefact contains the packages and the pinned runtime binary. It contains no
 * credential (verified by grepping the image), no config or brief and no project (excluded,
 * like snapshots). `--fresh` bypasses it.
 */
const IMAGE_EXCLUDES = ["./work", "./proc", "./sys", "./dev", "./tmp", "./run", "./.moat", "./var/log/moat"]

export function imageCachePath(
  packages: string[] = PROVISION_PACKAGES,
  binaries: readonly string[] = [RUNTIME_BINARY],
  runtimeKey: string = CODEX_VERSION,
): string {
  // The binaries and their pinned versions are part of the key: an image built before a binary
  // existed, or before its version changed, must never be handed to an environment that needs
  // it. The measured form of that bug is a cached image with the binary missing, which
  // surfaces as "command not found" in the box.
  const key = crypto
    .createHash("sha256")
    .update(
      `${ALPINE_VERSION}|${runtimeKey}|${SANDBOX_TRIPLE}|${[...binaries].sort().join(",")}|${[...packages].sort().join(",")}`,
    )
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
  opts: { useImageCache?: boolean; packages?: string[]; runtime?: RuntimeId } = {},
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

  const runtime = opts.runtime ?? "codex"
  const imageCache = imageCachePath(packages, [runtimeBinaryPath(runtime)], runtimeCacheKey(runtime))
  const useImageCache = opts.useImageCache !== false

  if (useImageCache && fs.existsSync(imageCache)) {
    const sidecar = `${imageCache}.sha256`
    let usable = true
    if (fs.existsSync(sidecar)) {
      const expected = fs.readFileSync(sidecar, "utf8").trim().split(/\s+/)[0] ?? ""
      usable = expected.length > 0 && (await verifyFile(imageCache, { sha256: expected }))
      if (!usable) {
        log.warn(`cached image failed its recorded digest and will be rebuilt: ${path.basename(imageCache)}`)
        fs.rmSync(imageCache, { force: true })
        fs.rmSync(sidecar, { force: true })
      }
    } else {
      log.debug(`cached image predates digest recording, using it as-is: ${path.basename(imageCache)}`)
    }
    if (usable) {
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

  {
    const binary = await ensureRuntimeBinary(runtime)
    const target = path.join(p.rootfs, runtimeBinaryPath(runtime).slice(1))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(binary, target)
    fs.chmodSync(target, 0o755)
    t = mark(`install ${runtime}`, t)
  }

  // The config and the brief are NOT baked into the image: `moat up` renders and writes them
  // on every boot, so there is exactly one place that decides the policy and a cached image
  // can never serve a stale one.
  fs.mkdirSync(path.join(p.rootfs, "var/log/moat"), { recursive: true })
  fs.mkdirSync(p.work, { recursive: true })
  fs.mkdirSync(p.snapshots, { recursive: true })
  fs.mkdirSync(p.logs, { recursive: true })

  // Save the finished image for the next environment, so the mirror is a
  // one-time dependency per (alpine, codex, package-set) combination.
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
    "root/.codex",
  ]) {
    ensureRootfsDir(rootfs, `/${dir}`)
  }
  writeRootfsFile(rootfs, "/etc/hosts", "127.0.0.1 localhost\n::1 localhost\n")
  chmodRootfsDir(rootfs, "/tmp", 0o1777)

  // A sandbox-owned git identity. Written as a file on the host, which needs no
  // privileges, and baked into the image so it survives across boots and across
  // environments. The host's ~/.gitconfig is never read or copied, that is the
  // point: the agent's commits are attributable to moat, not to the user.
  ensureRootfsDir(rootfs, "/root")
  writeRootfsFile(
    rootfs,
    "/root/.gitconfig",
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
  const tmp = partPath(dest)
  const args = ["-czf", tmp, "-C", p.rootfs]
  for (const exclude of IMAGE_EXCLUDES) args.push(`--exclude=${exclude}`)
  args.push(".")
  try {
    await run("tar", args)
    // Record what was written so a later boot can tell a complete cache entry
    // from one that was corrupted or truncated after the fact.
    const digest = await hashFile(tmp, "sha256", "hex")
    fs.renameSync(tmp, dest)
    fs.writeFileSync(`${dest}.sha256`, `${digest}  ${path.basename(dest)}\n`, { mode: 0o644 })
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

export async function ensurePackages(
  p: EnvPaths,
  packages: string[],
  opts: { post?: string[]; onOutput?: (chunk: string) => void; resetFirst?: boolean } = {},
): Promise<{ installed: string[]; alreadyPresent: string[] }> {
  const post = (opts.post ?? []).join("\n")
  // `apk add` trusts the package database, and the database can be right while the
  // files are gone: the agent is root inside the box and can delete a binary
  // without touching apk's records. `resetFirst` clears the entry so the install
  // actually restores the files.
  const installedTest = opts.resetFirst ? "false" : 'apk info -e "$pkg" >/dev/null 2>&1'
  const reset = opts.resetFirst ? "apk del $wanted >/dev/null 2>&1 || true" : ""
  const script = `#!/bin/sh
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
wanted="${packages.join(" ")}"
${reset}
missing=""
present=""
for pkg in $wanted; do
  if ${installedTest}; then present="$present $pkg"; else missing="$missing $pkg"; fi
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
  // leaves a half-written snapshot that looks usable. The temp name is unique per
  // call: two snapshots of the same name used to share `.part`, and the loser's
  // rename threw ENOENT after its tar had already succeeded.
  const tmp = partPath(file)
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

/**
 * Remove an environment's directory.
 *
 * Takes paths rather than a project directory on purpose: an environment whose
 * project directory no longer exists is precisely the one that has to be
 * deletable, and `envPaths` cannot build paths for it.
 */
export function destroyEnv(p: EnvPaths): boolean {
  if (!fs.existsSync(p.dir)) return false
  fs.rmSync(p.dir, { recursive: true, force: true })
  return true
}

export async function listSnapshots(p: EnvPaths): Promise<{ name: string; bytes: number; mtime: string }[]> {
  if (!fs.existsSync(p.snapshots)) return []
  const entries = fs
    .readdirSync(p.snapshots)
    .filter((f) => f.endsWith(".tar.gz") && SNAPSHOT_NAME.test(f.replace(/\.tar\.gz$/, "")))
  const snapshots: { name: string; bytes: number; mtime: string }[] = []
  for (const file of entries) {
    // `statSync` follows the link, so one dangling symlink in this directory threw
    // ENOENT and took the whole listing with it: `moat status` and `moat snapshot`
    // failed with a raw filesystem error because of one entry. The directory lives
    // inside the environment, and a snapshot is a regular file moat wrote (or a
    // restore staged), so anything else is skipped rather than guessed at — and the
    // snapshots that really are there still list.
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(path.join(p.snapshots, file))
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    snapshots.push({ name: file.replace(/\.tar\.gz$/, ""), bytes: stat.size, mtime: stat.mtime.toISOString() })
  }
  return snapshots.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
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
  // Atomic, like the other cache writes: a failed tar must not leave a partial
  // baseline that looks like a restorable image.
  const tmp = partPath(dest)
  const args = ["-czf", tmp, "-C", p.rootfs]
  for (const exclude of SNAPSHOT_EXCLUDES) args.push(`--exclude=${exclude}`)
  args.push(".")
  const result = spawnSync("tar", args, { stdio: ["ignore", "ignore", "pipe"] })
  if (result.status !== 0) {
    fs.rmSync(tmp, { force: true })
    throw new Error(`baseline snapshot failed: ${result.stderr?.toString() ?? ""}`)
  }
  fs.renameSync(tmp, dest)
  return { bytes: fs.statSync(dest).size, linked: false }
}
