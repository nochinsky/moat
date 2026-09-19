import { spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { EnvPaths } from "../lib/paths.ts"
import { shellQuote } from "../lib/shell.ts"
import * as log from "../lib/log.ts"

/**
 * The sandbox launcher.
 *
 * moat does not use Docker, podman or any container runtime. It builds the
 * isolation directly out of Linux primitives, because that is the only thing
 * that works with zero privileges on the target host:
 *
 *   unshare --user --map-root-user   -> we become uid 0 *inside* a user namespace,
 *                                       mapped to the calling user outside it
 *           --mount                  -> private mount namespace
 *           --pid --fork             -> private PID namespace (sandbox sees only itself)
 *           --uts --ipc              -> private hostname and IPC
 *           --kill-child             -> sandbox dies with the supervisor
 *
 * Inside that namespace the outer script:
 *   1. binds the persistent rootfs onto a scratch mount point,
 *   2. builds a mount table (proc, tmpfs /dev, devpts, /dev/shm, /tmp, /run),
 *   3. bind-mounts *device nodes only* from the host (see DEVICE_NODES note),
 *   4. chroots into it and execs the entry script.
 *
 * What is deliberately NOT here: no bind mount of the project, the home
 * directory, the SSH agent, the container socket, or any host environment
 * variable. Copy-in happens before boot (see sync/copyin.ts); copy-out happens
 * through git (see sync/copyout.ts).
 *
 * DEVICE_NODES note: `mknod` is refused inside an unprivileged user namespace
 * (verified: EPERM), so /dev/null and friends cannot be created from nothing.
 * Every rootless runtime resolves this the same way: bind the host's *device
 * nodes*. They are bound read-write, because a device node is an interface
 * rather than a file and a read-only bind makes `> /dev/null` fail with EACCES
 * (verified); they carry no host data, and they are the only host-originated
 * mount in the sandbox. `moat doctor` prints the full mount table, root field
 * included, so you can check that claim yourself.
 */
const DEVICE_NODES = ["null", "zero", "full", "random", "urandom", "tty"] as const

export type SandboxSpawn = {
  rootfs: string
  mountpoint: string
  entry: string
  /** Absolute path inside the rootfs of a script to exec. */
  innerScript: string
}

export function newroot(p: EnvPaths): string {
  return p.mountpoint
}

/**
 * Process identity, from /proc/<pid>/stat field 22 (starttime, in clock ticks
 * since boot).
 *
 * A pid is not an identity. After a reboot, or after a crash whose pid was
 * reused, the number in state.json can belong to an unrelated process, and
 * `moat down` sends SIGTERM and then SIGKILL to its whole process group. The
 * start time is the cheap, standard way to tell "the process I started" from
 * "whatever has that number now".
 */
export function processStartTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const close = stat.lastIndexOf(")")
    if (close < 0) return null
    const fields = stat.slice(close + 2).split(" ")
    // fields[0] is state (overall field 3), so starttime is fields[19].
    return fields[19] ?? null
  } catch {
    return null
  }
}

/** The command line from /proc, NUL-separated, as one string. */
export function processCommand(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim() || null
  } catch {
    return null
  }
}

export type PidStatus = "gone" | "ours" | "stale"

/**
 * Is the pid moat recorded actually this environment's sandbox?
 *
 * `ours` requires the recorded start time to match. Environments written before
 * that was recorded fall back to the environment id appearing in the command
 * line (the boot script path contains it). Anything else is `stale`, and a
 * stale pid is never signalled.
 */
export function sandboxPidStatus(
  pid: number | null,
  opts: { startTime?: string | null; envId?: string } = {},
): PidStatus {
  if (!pid || !isRunning(pid)) return "gone"
  const expected = opts.startTime ?? null
  if (expected) return processStartTime(pid) === expected ? "ours" : "stale"
  if (opts.envId) {
    const command = processCommand(pid)
    return command && command.includes(opts.envId) ? "ours" : "stale"
  }
  return "stale"
}

/**
 * The outer script runs on the *host* filesystem, inside the fresh namespaces,
 * using the host's own `mount`/`chroot`. Keeping it in a file (rather than in
 * `sh -c`) removes an entire class of quoting bugs, and means the exact boot
 * sequence is auditable on disk after the fact.
 */
export type OuterScriptOptions = {
  /** Absolute path of the entry script this boot should exec (defaults to entry.sh). */
  innerScript?: string
  /**
   * When set, the boot moves its stdout/stderr to this path inside the rootfs.
   * The box then holds no file descriptor on a host path outside itself; the
   * host log only ever sees the handful of lines before the redirect.
   */
  bootLog?: string
}

export function outerScript(p: EnvPaths, opts: OuterScriptOptions = {}): string {
  const N = shellQuote(newroot(p))
  const R = shellQuote(p.rootfs)
  const entry = opts.innerScript ?? p.entryScript
  const inner = shellQuote(`/.moat/${path.basename(entry)}`)
  const lines: string[] = []
  lines.push("#!/bin/sh")
  lines.push("# GENERATED BY moat, the exact sandbox boot sequence. No project data is mounted.")
  lines.push("# /dev/* are host device nodes, bound read-write: an interface, not host data.")
  lines.push("set -eu")
  lines.push(`N=${N}`)
  lines.push(`R=${R}`)
  // Make the whole tree private first, so nothing we mount here can propagate
  // back into the host's mount namespace.
  lines.push(`mount --make-rprivate / 2>/dev/null || true`)
  lines.push(`mkdir -p "$N"`)
  lines.push(`mount --bind "$R" "$N"`)
  if (opts.bootLog) {
    lines.push(`mkdir -p ${shellQuote(path.dirname(opts.bootLog))} 2>/dev/null || true`)
    lines.push(`exec >> ${shellQuote(opts.bootLog)} 2>&1`)
  }
  lines.push(`mount -t proc proc "$N/proc"`)
  lines.push(`mount -t tmpfs -o mode=755,nosuid tmpfs "$N/dev"`)
  lines.push(`mkdir -p "$N/dev/pts" "$N/dev/shm"`)
  for (const node of DEVICE_NODES) {
    lines.push(`if [ -e /dev/${node} ]; then : > "$N/dev/${node}"; mount --bind "/dev/${node}" "$N/dev/${node}" 2>/dev/null || true; fi`)
  }
  // devpts must not be given gid=5: gid 5 is not mapped in our single-id user
  // namespace and the mount fails with EINVAL. Verified behaviour.
  lines.push(`mount -t devpts -o newinstance,ptmxmode=0666,mode=620 devpts "$N/dev/pts" 2>/dev/null || true`)
  lines.push(`ln -sf pts/ptmx "$N/dev/ptmx"`)
  lines.push(`mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$N/dev/shm"`)
  lines.push(`mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$N/tmp"`)
  lines.push(`mount -t tmpfs -o mode=755,nosuid,nodev tmpfs "$N/run"`)
  // A copy, not a mount: the sandbox needs a resolver and has no host netns of its own.
  lines.push(`cp /etc/resolv.conf "$N/etc/resolv.conf" 2>/dev/null || true`)
  lines.push(`exec chroot "$N" /bin/sh ${inner}`)
  return `${lines.join("\n")}\n`
}

/** Write a file and rename it into place, so a reader never sees a partial script. */
function writeAtomic(file: string, body: string, mode: number): void {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, body, { mode })
  fs.renameSync(tmp, file)
}

/** Keep the newest `keep` files matching a pattern, so scripts cannot pile up. */
function pruneScripts(dir: string, pattern: RegExp, keep: number): void {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const matching = names
    .filter((name) => pattern.test(name))
    .map((name) => {
      const full = path.join(dir, name)
      let mtime = 0
      try {
        mtime = fs.statSync(full).mtimeMs
      } catch {
        /* ignore */
      }
      return { full, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
  for (const entry of matching.slice(keep)) fs.rmSync(entry.full, { force: true })
}

/**
 * Write the outer boot script.
 *
 * Each invocation gets its own file, named by pid and a random suffix, because
 * two host processes can boot the same environment at once (`moat doctor`
 * while `moat up` runs, `moat exec` during a restart) and a single fixed
 * `boot.sh` would be overwritten between write and exec. The canonical
 * `runtime/boot.sh` is refreshed as an audit copy of the most recent boot.
 */
export function writeOuterScript(p: EnvPaths, opts: OuterScriptOptions = {}): string {
  const dir = path.join(p.dir, "runtime")
  fs.mkdirSync(dir, { recursive: true })
  const text = outerScript(p, opts)
  const file = path.join(dir, `boot-${process.pid}-${crypto.randomBytes(4).toString("hex")}.sh`)
  writeAtomic(file, text, 0o700)
  writeAtomic(path.join(dir, "boot.sh"), text, 0o700)
  pruneScripts(dir, /^boot-\d+-[0-9a-f]+\.sh$/, 8)
  return file
}

/** Write the script that executes *inside* the rootfs. It must never contain a secret. */
export function writeInnerScript(p: EnvPaths, body: string): string {
  const dir = path.join(p.rootfs, ".moat")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `entry-${process.pid}-${crypto.randomBytes(4).toString("hex")}.sh`)
  writeAtomic(file, body, 0o755)
  // Audit copy: the documented path, always the most recent entry script.
  writeAtomic(p.entryScript, body, 0o755)
  pruneScripts(dir, /^entry-\d+-[0-9a-f]+\.sh$/, 8)
  return file
}

export type SandboxEnv = Record<string, string | undefined>

/** The only environment variables that reach the sandbox. Nothing is forwarded implicitly. */
export function sandboxEnv(extra: SandboxEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/root",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    MOAT_SANDBOX: "1",
    ...extra,
  } as NodeJS.ProcessEnv
}

/**
 * Escape hatch for experiments: extra KEY=VALUE pairs for the sandbox
 * environment, from MOAT_SANDBOX_ENV.
 *
 * Names are restricted to the OPENCODE_/MOAT_ prefixes so this cannot become a
 * channel that forwards host environment into the box, and names moat manages
 * itself are refused. The reserved list matters: this map used to be spread
 * *after* the credential and the server password, so an ambient MOAT_ variable
 * could silently replace either inside the box.
 */
export function extraSandboxEnv(
  source: string | undefined = process.env.MOAT_SANDBOX_ENV,
  reserved: string[] = [],
): Record<string, string> {
  if (!source) return {}
  const result: Record<string, string> = {}
  for (const pair of source.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
    const index = pair.indexOf("=")
    if (index === -1) continue
    const key = pair.slice(0, index)
    if (!/^(OPENCODE_|MOAT_)/.test(key)) {
      log.warn(`ignoring MOAT_SANDBOX_ENV entry ${key}: only OPENCODE_/MOAT_ prefixed names may enter the sandbox`)
      continue
    }
    if (reserved.includes(key)) {
      log.warn(`ignoring MOAT_SANDBOX_ENV entry ${key}: moat manages that variable`)
      continue
    }
    result[key] = pair.slice(index + 1)
  }
  return result
}

export function unshareArgs(inner: string): string[] {
  return [
    "--user",
    "--map-root-user",
    "--mount",
    "--pid",
    "--fork",
    "--uts",
    "--ipc",
    "--kill-child",
    "sh",
    inner,
  ]
}

export type RunInSandboxResult = { code: number; output: string; timedOut: boolean }

// Captured output is bounded: a project's test suite can print gigabytes, and
// the host process must not grow with it. The head is kept because the doctor's
// markers are printed first, the tail because test verdicts are printed last.
const MAX_CAPTURED_OUTPUT = 4 * 1024 * 1024
const OUTPUT_HEAD = 256 * 1024
const OUTPUT_TAIL = 512 * 1024

/** Run a script inside a *fresh, ephemeral* boot of the sandbox and wait for it. */
export async function runInSandbox(
  p: EnvPaths,
  innerBody: string,
  opts: { env?: SandboxEnv; onOutput?: (chunk: string) => void; timeoutMs?: number } = {},
): Promise<RunInSandboxResult> {
  const inner = writeInnerScript(p, innerBody)
  const boot = writeOuterScript(p, { innerScript: inner })
  return await new Promise((resolve, reject) => {
    const child = spawn("unshare", unshareArgs(boot), {
      env: sandboxEnv(opts.env),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    let timedOut = false
    const sink = (chunk: string) => {
      output += chunk
      if (output.length > MAX_CAPTURED_OUTPUT + 64 * 1024) {
        output =
          output.slice(0, OUTPUT_HEAD) +
          "\n[moat] output truncated by the host\n" +
          output.slice(-OUTPUT_TAIL)
      }
      opts.onOutput?.(chunk)
    }
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", sink)
    child.stderr.on("data", sink)
    child.on("error", reject)
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          // unshare --kill-child takes the namespace down with it.
          child.kill("SIGKILL")
        }, opts.timeoutMs)
      : null
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, output, timedOut })
    })
  })
}

export type SandboxProcess = {
  child: ChildProcess
  pid: number
  /** Identity of the process we started, so a reused pid is never signalled. */
  startTime: string | null
  logFile: string
}

/** Boot the sandbox as a long-running server, detached into its own process group. */
export function startSandbox(p: EnvPaths, innerBody: string, env: SandboxEnv): SandboxProcess {
  const inner = writeInnerScript(p, innerBody)
  // The boot log lives inside the rootfs, so the long-running box does not hold
  // an append fd on a host file outside itself.
  const bootLog = path.join(p.rootfs, "var", "log", "moat", "boot.log")
  const boot = writeOuterScript(p, { innerScript: inner, bootLog })
  fs.mkdirSync(p.logs, { recursive: true })
  const logFile = path.join(p.logs, "sandbox.log")
  const fd = fs.openSync(logFile, "a", 0o600)
  const child = spawn("unshare", unshareArgs(boot), {
    env: sandboxEnv(env),
    stdio: ["ignore", fd, fd],
    detached: true,
  })
  child.unref()
  fs.closeSync(fd)
  if (!child.pid) throw new Error("failed to spawn sandbox: no pid")
  return { child, pid: child.pid, startTime: processStartTime(child.pid), logFile }
}

/**
 * Stop a sandbox by killing its whole process group.
 *
 * The group is created by `detached: true`, so a single negative-pid signal
 * reaches unshare, the boot script and opencode together; `--kill-child` on
 * unshare then guarantees the PID-namespace init cannot outlive it.
 */
export async function stopSandbox(
  pid: number,
  opts: { timeoutMs?: number; startTime?: string | null; envId?: string } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const alive = (): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  if (!alive()) return true
  // Never signal a pid that is not the process moat started. The caller clears
  // the recorded pid either way; it just does not get to kill a bystander.
  const status = sandboxPidStatus(pid, { startTime: opts.startTime, envId: opts.envId })
  if (status === "stale") {
    log.warn(
      `refusing to signal pid ${pid}: it is not the sandbox moat recorded ` +
        `(the pid was reused, or another process owns it now)`,
    )
    return true
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  log.debug(`sandbox pid ${pid} had not exited after ${timeoutMs}ms; escalating to SIGKILL`)
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 200))
  return !alive()
}

export function isRunning(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
