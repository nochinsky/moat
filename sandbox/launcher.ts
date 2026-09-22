import { spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { EnvPaths } from "../lib/paths.ts"
import { SLIRP_DNS, ownNetns, type EgressMode } from "../lib/pins.ts"
import { containerName, containerPlan, containerRunning, containerStop, containerRuntime, type BackendId } from "./backend.ts"
import { ensureRootfsDir, openRootfsFileForAppend, writeRootfsFile } from "../lib/rootfs-fs.ts"
import { shellQuote } from "../lib/shell.ts"
import { proxyEnv } from "./proxy.ts"
import { VETH_BOX_IFACE } from "./proxy-netns.ts"
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
/**
 * The heredoc delimiter that carries the egress ruleset inside the boot script.
 *
 * A quoted delimiter means the shell reads the body literally: no expansion, no
 * command substitution, nothing a rule could use to escape the data position. It
 * is a constant rather than interpolated so a ruleset can never forge the end of
 * its own heredoc.
 */
export const NFT_HEREDOC_MARKER = "MOAT_EGRESS_RULESET_EOF"

export type OuterScriptOptions = {
  /** Absolute path of the entry script this boot should exec (defaults to entry.sh). */
  innerScript?: string
  /**
   * When set, the boot moves its stdout/stderr to descriptor 3 after the mounts.
   *
   * The descriptor is opened and verified on the host (see
   * `openRootfsFileForAppend`) and inherited by the boot script. The script must
   * never resolve the log's path itself: the log lives in the agent-writable
   * rootfs, and a symlink planted there would make the *host* process write
   * wherever it points. The handful of lines before the dup go to
   * `logs/sandbox.log` outside the box.
   */
  bootLog?: boolean
  /**
   * Wait for slirp4netns to attach tap0 and resolve through it. Set when the
   * sandbox has its own network namespace: the tap appears asynchronously from
   * the host, and the host's resolver is unreachable from inside.
   */
  waitForTap?: boolean
  /**
   * Wait for the proxy's link to appear before anything runs, by interface name.
   *
   * The link is built by the host *after* the boot starts, because building it needs this process's
   * pid — so without a wait the boot races the host, and a boot that finishes quickly (an
   * `moat exec -- echo hi`) is gone before the link exists: measured, the host's build then failed
   * with `cannot open /proc/<pid>/ns/user: No such file or directory`. Same shape as `waitForTap`, and
   * the same reason.
   */
  waitForLink?: string
  /**
   * The nftables ruleset to apply before anything runs, as text.
   *
   * Set when egress is filtered: the rules go on inside the sandbox's own network
   * namespace, which moat owns, before the entry script starts.
   *
   * It is the ruleset *itself*, not a path to it, and that is the whole point. It
   * used to be a path inside the rootfs (`/.moat/egress.nft`), which the agent is
   * root enough to rewrite: the boot would then faithfully apply whatever policy
   * the box had left there, and the box would come up "filtered" under rules the
   * agent chose. The boot script is written outside the rootfs (`runtime/`), so
   * carrying the text here means the policy cannot be edited by the thing it
   * constrains. Same reasoning as the boot log's descriptor, different mechanism:
   * there is no path resolve left to race.
   */
  egressRules?: string
}

export function outerScript(p: EnvPaths, opts: OuterScriptOptions = {}): string {
  const N = shellQuote(newroot(p))
  const R = shellQuote(p.rootfs)
  const entry = opts.innerScript ?? p.entryScript
  const lines: string[] = []
  lines.push("#!/bin/sh")
  lines.push("# GENERATED BY moat, the exact sandbox boot sequence. No project data is mounted.")
  lines.push("# /dev/* are host device nodes, bound read-write: an interface, not host data.")
  lines.push("set -eu")
  lines.push(`N=${N}`)
  lines.push(`R=${R}`)
  // Make the whole tree private first, so nothing we mount here can propagate
  // back into the host's mount namespace. This is a boundary rather than hygiene — the very
  // next command binds the rootfs, and a host path is the target — so a failure refuses the
  // boot instead of leaving the sandbox's mounts able to propagate.
  lines.push(
    'if ! mount --make-rprivate / 2>/dev/null; then echo "[moat] could not make the mount tree private; refusing to boot" >&2; exit 1; fi',
  )
  lines.push(`mkdir -p "$N"`)
  lines.push(`mount --bind "$R" "$N"`)
  if (opts.bootLog) {
    // Dup, do not redirect by path: fd 3 is the file the host opened and
    // verified, so nothing here can be pointed at a host directory.
    lines.push("exec 1>&3 2>&3")
  }
  lines.push(`mount -t proc proc "$N/proc"`)
  lines.push(`mount -t tmpfs -o mode=755,nosuid tmpfs "$N/dev"`)
  lines.push(`mkdir -p "$N/dev/pts" "$N/dev/shm"`)
  // A failed bind used to be swallowed by `|| true` after `: >`, which left the empty regular
  // file behind: the box booted with a /dev/null that writes into its own rootfs, a /dev/urandom
  // that returns nothing, and no symptom until something needed one. The bind fails the script
  // now (set -e), and the result is checked to be a character device as well.
  for (const node of DEVICE_NODES) {
    lines.push(`: > "$N/dev/${node}"`)
    lines.push(`mount --bind "/dev/${node}" "$N/dev/${node}"`)
    lines.push(
      `if [ ! -c "$N/dev/${node}" ]; then echo "[moat] /dev/${node} is not a device node in the sandbox; refusing to boot" >&2; exit 1; fi`,
    )
  }
  // devpts must not be given gid=5: gid 5 is not mapped in our single-id user
  // namespace and the mount fails with EINVAL. Verified behaviour.
  lines.push(`mount -t devpts -o newinstance,ptmxmode=0666,mode=620 devpts "$N/dev/pts"`)
  lines.push(
    'if ! mountpoint -q "$N/dev/pts"; then echo "[moat] /dev/pts did not mount; refusing to boot" >&2; exit 1; fi',
  )
  lines.push(`ln -sf pts/ptmx "$N/dev/ptmx"`)
  lines.push(`mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$N/dev/shm"`)
  lines.push(`mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$N/tmp"`)
  lines.push(`mount -t tmpfs -o mode=755,nosuid,nodev tmpfs "$N/run"`)
  // A copy, not a mount: the sandbox needs a resolver and has no host netns of its own.
  lines.push(`cp /etc/resolv.conf "$N/etc/resolv.conf" 2>/dev/null || true`)
  if (opts.waitForTap) {
    // The sandbox is in its own network namespace. slirp4netns attaches tap0
    // from the host, and the box resolves through slirp, not the host resolver.
    lines.push("i=0")
    lines.push("while ! grep -q tap0 /proc/net/dev; do")
    lines.push("  i=$((i+1))")
    lines.push("  if [ \"$i\" -ge 100 ]; then echo '[moat] slirp tap0 did not appear' >&2; exit 1; fi")
    lines.push("  sleep 0.1")
    lines.push("done")
    lines.push("echo nameserver " + SLIRP_DNS + " > \"$N/etc/resolv.conf\"")
  }
  if (opts.waitForLink) {
    // A boot that cannot get its link must not run anyway: it would come up with a proxy in its
    // environment and no way to reach it, which reads as a broken network rather than a failed boot.
    lines.push("i=0")
    lines.push(`while ! grep -q ${opts.waitForLink} /proc/net/dev; do`)
    lines.push("  i=$((i+1))")
    lines.push(`  if [ "$i" -ge 100 ]; then echo '[moat] the proxy link did not appear' >&2; exit 1; fi`)
    lines.push("  sleep 0.1")
    lines.push("done")
  }
  if (opts.egressRules) {
    // A policy that fails to load must stop the boot: running unfiltered while
    // the environment claims to be filtered is worse than not booting at all.
    //
    // The ruleset is fed to nft on stdin from a variable in *this* script, which
    // the agent cannot write, rather than read from a path inside its own rootfs.
    // It used to be `/.moat/egress.nft` in the rootfs, which the box is root
    // enough to rewrite: the boot then applied whatever policy the box had left
    // there, and came up "filtered" under rules the agent chose. `nft -f -` is
    // nftables' own stdin form; test/e2e-egress.sh measures that the allowlist
    // holds and that everything else is dropped.
    //
    // `printf '%s\n'` and not `echo`: a ruleset line a shell would treat as an
    // option stays data, which is the same reason this is not a heredoc (a
    // heredoc body has to come after every command that follows it, including the
    // exec at the end of this script).
    const marker = NFT_HEREDOC_MARKER
    lines.push(`MOAT_EGRESS=$(cat <<'${marker}'`)
    lines.push(opts.egressRules.replace(/\n$/, ""))
    lines.push(marker)
    lines.push(")")
    lines.push(
      "if ! chroot \"$N\" /bin/sh -c 'PATH=/usr/sbin:/usr/bin:/sbin:/bin; command -v nft >/dev/null'; then",
    )
    lines.push('  echo "[moat] filtered egress needs nft inside the box, and this image has none" >&2; exit 1')
    lines.push("fi")
    lines.push(
      "if ! printf '%s\\n' \"$MOAT_EGRESS\" | chroot \"$N\" /bin/sh -c 'PATH=/usr/sbin:/usr/bin:/sbin:/bin; nft -f -'; then",
    )
    lines.push('  echo "[moat] failed to apply the egress policy" >&2; exit 1')
    lines.push("fi")
    // The variable is not needed past the chroot, and the entry script inherits
    // this environment: leaving it set would put the policy in the box's env.
    lines.push("unset MOAT_EGRESS")
  }
  // `cd /` explicitly rather than relying on chroot's own chdir: the barrier is the chroot, and
  // a cwd above the new root would let `..` walk the host tree. `unset OLDPWD` is not tidiness:
  // dash's `cd` exports it, the box would inherit the host's previous directory, and
  // `moat doctor`'s env diff reports it as a host variable in the sandbox (measured).
  const innerPath = `/.moat/${path.basename(entry)}`
  lines.push(`exec chroot "$N" /bin/sh -c ${shellQuote(`cd / && unset OLDPWD && exec ${innerPath}`)}`)
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
  // Inside the rootfs, so it goes through the guard: the agent can replace
  // /.moat with a symlink, and a host path would then receive the entry script.
  ensureRootfsDir(p.rootfs, "/.moat")
  const name = `entry-${process.pid}-${crypto.randomBytes(4).toString("hex")}.sh`
  const file = writeRootfsFile(p.rootfs, `/.moat/${name}`, body, 0o755)
  // Audit copy: the documented path, always the most recent entry script.
  writeRootfsFile(p.rootfs, "/.moat/entry.sh", body, 0o755)
  pruneScripts(dir, /^entry-\d+-[0-9a-f]+\.sh$/, 8)
  return file
}

export type SandboxEnv = Record<string, string | undefined>

/**
 * The command that boots the box, whichever backend is in use.
 *
 * The unshare path needs its outer script (mount table, device binds, chroot); a container runtime
 * does all of that itself, so its plan runs the *inner* script directly. This is the one place that
 * knows the difference, which is why the three spawn sites below are one line each.
 *
 * The runtime process gets the **host** environment, not the box's: podman needs `HOME` and
 * `XDG_RUNTIME_DIR` to find its own storage, and the box's environment is what `--env` lists.
 * Nothing from the host reaches the box by this route — that is invariant 5, and it is about the
 * box, not about the daemon moat asks to build it.
 */
/**
 * The inner script for a container boot that has to apply the egress ruleset.
 *
 * The unshare path applies it from its outer script, after the mounts. A container has no outer
 * script — that is the whole point of the backend — so something inside the box has to do it, and
 * that something is a wrapper: it checks `nft` is present, feeds the ruleset to `nft -f -` from a
 * heredoc in the file (never from argv, and never from a path inside the agent-writable rootfs,
 * where the agent could rewrite the policy it is about to be held to), and execs the real entry
 * script. `test/e2e-egress.sh` measures the same property on the unshare path.
 */
export function writeEgressWrapper(p: EnvPaths, inner: string, ruleset: string): string {
  const body = `#!/bin/sh
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if ! command -v nft >/dev/null; then
  echo "[moat] filtered egress needs nft inside the box, and this image has none" >&2
  exit 1
fi
if ! nft -f - <<'${NFT_HEREDOC_MARKER}'
${ruleset}
${NFT_HEREDOC_MARKER}
then
  echo "[moat] failed to apply the egress policy" >&2
  exit 1
fi
exec /bin/sh ${shellQuote("/" + path.posix.relative(p.rootfs, inner))}
`
  const name = `wrap-${process.pid}-${crypto.randomBytes(4).toString("hex")}.sh`
  return writeRootfsFile(p.rootfs, `/.moat/${name}`, body, 0o755)
}

function bootCommand(
  p: EnvPaths,
  opts: {
    backend?: BackendId
    inner: string
    outer: string
    egress?: EgressMode
    env?: SandboxEnv
    isolated: boolean
    egressRules?: string
    /** Set only for the long-running box; see ContainerPlanOptions.name. */
    name?: string
  },
): { command: string; args: string[]; env: NodeJS.ProcessEnv; needsSlirp: boolean } {
  if (opts.backend === "container") {
    // A filtered boot still needs the ruleset applied, and there is no outer script to apply it in.
    const inner = opts.egressRules ? writeEgressWrapper(p, opts.inner, opts.egressRules) : opts.inner
    const plan = containerPlan(p, inner, { egress: opts.egress, env: opts.env, ...(opts.name ? { name: opts.name } : {}) })
    return { command: plan.command, args: plan.args, env: process.env, needsSlirp: false }
  }
  const isolated = opts.isolated
  return {
    command: "unshare",
    args: unshareArgs(opts.outer, { net: isolated }),
    env: sandboxEnv(opts.env),
    needsSlirp: isolated,
  }
}

/**
 * The terminal type an *interactive* boot should advertise.
 *
 * `sandboxEnv` fixes `TERM=dumb`, which is right for a boot nobody is watching — a script, a
 * check, the server — and wrong for one attached to a terminal. Measured: with the codex
 * runtime, `moat` reached the TUI and Codex stopped at
 * "WARNING: TERM is set to \"dumb\". Codex's interactive TUI may not work in this terminal.
 * Continue anyway? [y/N]" — the first thing a new user would see. bash is degraded the same
 * way (no colours, no line editing).
 *
 * Only the terminal *type* is forwarded, and it is sanitised: it is a capability name from
 * the host environment, not host data, and a value with whitespace or punctuation has no
 * business being exported into the box.
 */
export function interactiveTerm(host: string | undefined = process.env.TERM): string {
  const value = (host ?? "").trim()
  if (value.length === 0 || value === "dumb" || !/^[A-Za-z0-9._+-]+$/.test(value)) return "xterm-256color"
  return value
}

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
 * Names are restricted to moat's own MOAT_ prefix so this cannot become a
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
    if (!/^MOAT_/.test(key)) {
      log.warn(`ignoring MOAT_SANDBOX_ENV entry ${key}: only MOAT_ prefixed names may enter the sandbox`)
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

export function unshareArgs(inner: string, opts: { net?: boolean } = {}): string[] {
  return [
    "--user",
    "--map-root-user",
    "--mount",
    "--pid",
    "--fork",
    "--uts",
    "--ipc",
    // A private network namespace is what takes away the host's network
    // position; slirp4netns is then the only way out.
    ...(opts.net ? ["--net"] : []),
    "--kill-child",
    "sh",
    inner,
  ]
}

/**
 * Whether a boot gets its own network namespace, and the guards around it.
 *
 * `filtered` is `isolated` plus a ruleset: the same namespace and the same slirp
 * datapath, with nftables dropping everything the allowlist does not name. A
 * `filtered` boot that kept the host's network namespace would apply the ruleset
 * as an unprivileged user — `netlink: Error: cache initialization failed` — and a
 * box that says "filtered" while sharing the host's network is worse than one
 * that refuses to boot.
 */
export function bootIsolation(opts: { egress?: EgressMode; slirpBinary?: string; egressRules?: string }): boolean {
  const isolated = ownNetns(opts.egress ?? "open")
  if (isolated && !opts.slirpBinary) throw new Error(`${opts.egress} egress needs the slirp4netns binary`)
  if (opts.egressRules && !isolated) {
    throw new Error("an egress ruleset needs the sandbox's own network namespace")
  }
  return isolated
}

/**
 * Wait until a child has actually entered its new network namespace.
 *
 * slirp4netns is pointed at the child's pid, and attaching before the child's
 * unshare(2) has run would configure the *host's* namespace instead. The
 * namespace symlink differs the moment the child is in place.
 */
export async function waitForNewNetns(pid: number, timeoutMs = 5000): Promise<boolean> {
  let ours: string | null = null
  try {
    ours = fs.readlinkSync("/proc/self/ns/net")
  } catch {
    return false
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (fs.readlinkSync(`/proc/${pid}/ns/net`) !== ours) return true
    } catch {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

export type RunInSandboxResult = {
  code: number
  output: string
  timedOut: boolean
  /**
   * Why the box was stopped early, when something other than the clock ended it.
   *
   * The only caller today is the spend ceiling: a turn is killed the moment the usage it has
   * already reported crosses a limit the user set, rather than being allowed to finish and priced
   * after the fact. It is separate from `timedOut` because "the money ran out" and "the clock ran
   * out" are different things to tell a user.
   */
  aborted?: string
}

// Captured output is bounded: a project's test suite can print gigabytes, and
// the host process must not grow with it. The head is kept because the doctor's
// markers are printed first, the tail because test verdicts are printed last.
const MAX_CAPTURED_OUTPUT = 4 * 1024 * 1024
const OUTPUT_HEAD = 256 * 1024
const OUTPUT_TAIL = 512 * 1024

export type SandboxRunOptions = {
  env?: SandboxEnv
  /** Which backend boots this box: the default `unshare` path, or a container runtime. */
  backend?: BackendId
  onOutput?: (chunk: string) => void
  timeoutMs?: number
  egress?: EgressMode
  /** Path to the slirp4netns binary; required when egress is isolated. */
  slirpBinary?: string
  /** Path inside the sandbox of the nftables ruleset; required when filtered. */
  egressRules?: string
  /**
   * Enforce egress through a proxy moat owns, on this boot's own loopback.
   *
   * The box is told to use it through the environment (`proxyEnv`), and the proxy decides by name
   * and port before dialing — which is what the nftables allowlist cannot do: it is an IP snapshot
   * taken at boot, it cannot express per-host ports, and DNS is still an outbound channel.
   * `docs/EGRESS.md` has the measurements this rests on; `sandbox/proxy.ts` has the proxy.
   */
  egressProxy?: { allow: readonly string[] }
  /**
   * Called with the output so far, and may stop the box by returning a reason.
   *
   * This is how a spend ceiling is enforced *while* the turn is running: the runtime's own stream
   * reports usage as it goes (Claude Code sends it on every assistant event), so the host can price
   * what has been spent and kill the namespace before the next request is made. Returning null lets
   * it run.
   */
  abortWhen?: (output: string) => string | null
}

/** Run a script inside a *fresh, ephemeral* boot of the sandbox and wait for it. */
export async function runInSandbox(
  p: EnvPaths,
  innerBody: string,
  opts: SandboxRunOptions = {},
): Promise<RunInSandboxResult> {
  const containerBackend = opts.backend === "container"
  const isolated = containerBackend ? false : bootIsolation(opts)
  const inner = writeInnerScript(p, innerBody)
  // No outer script for a container: the mount table, the chroot and the device nodes are the
  // runtime's job, which is the entire reason the backend is worth having.
  const boot = containerBackend
    ? ""
    : writeOuterScript(p, {
        innerScript: inner,
        waitForTap: isolated,
        waitForLink: opts.egressProxy ? VETH_BOX_IFACE : undefined,
        egressRules: opts.egressRules,
      })
  // The proxy's variables are added here rather than by each caller: a boot that has the topology but
  // not the environment sends its traffic straight out, and the policy is silently absent.
  const plan = bootCommand(p, {
    backend: opts.backend,
    inner,
    outer: boot,
    egress: opts.egress,
    env: opts.egressProxy ? { ...(opts.env ?? {}), ...proxyEnv() } : opts.env,
    isolated,
    egressRules: opts.egressRules,
  })
  const child = spawn(plan.command, plan.args, {
    env: plan.env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let slirp: { stop: () => void } | null = null
  let proxy: { stop: () => void } | null = null
  let proxySlirp: { stop: () => void } | null = null
  let topology: { stop: () => void } | null = null
  const stopDatapath = (): void => {
    proxy?.stop()
    proxySlirp?.stop()
    slirp?.stop()
    // Last, so the processes that depend on the link are gone before the link is.
    topology?.stop()
  }
  try {
    if (plan.needsSlirp) {
      const egress = await import("./egress.ts")
      const ready = child.pid ? await waitForNewNetns(child.pid) : false
      if (!ready) throw new Error("the sandbox did not enter its network namespace")
      slirp = await egress.startSlirp(opts.slirpBinary!, child.pid!, { logFile: path.join(p.logs, "slirp.log") })
      if (opts.egressProxy) {
        // The proxy gets a namespace of its own with its own datapath, because a process inside the
        // box's namespace is subject to the box's ruleset — and the ruleset's addresses were resolved
        // at boot, which is the very snapshot this exists to retire. Measured both ways in
        // docs/EGRESS.md §7. The box keeps its own datapath and ruleset as the backstop for traffic
        // that ignores the proxy.
        const proxies = await import("./proxy.ts")
        const nets = await import("./proxy-netns.ts")
        const proxyLog = path.join(p.logs, "proxy.log")
        const built = await nets.startProxyNetns(child.pid!, { dir: p.logs, logFile: proxyLog })
        topology = built
        const datapath = await egress.startSlirp(opts.slirpBinary!, built.holderPid, {
          logFile: path.join(p.logs, "slirp-proxy.log"),
        })
        if (!datapath.pid || datapath.pid <= 0) {
          const reason = datapath.error()?.message ?? "the process did not start"
          throw new Error(`could not start the proxy's datapath (${opts.slirpBinary}): ${reason}`)
        }
        proxySlirp = datapath
        const handle = proxies.startEgressProxy(built.holderPid, {
          allow: opts.egressProxy.allow,
          logFile: proxyLog,
          bind: proxies.PROXY_ADDRESS,
          // slirp's resolver, sited in the namespace the proxy's traffic actually leaves from.
          dns: egress.SLIRP_DNS,
        })
        if (!handle.pid || handle.pid <= 0) {
          const reason = handle.error()?.message ?? "the process did not start"
          throw new Error(`could not start the egress proxy (${proxies.NSENTER}): ${reason}`)
        }
        proxy = handle
        if (!(await proxies.waitForProxyListening(proxyLog))) {
          throw new Error("the egress proxy did not report that it was listening")
        }
      }
    }
  } catch (error) {
    stopDatapath()
    child.kill("SIGKILL")
    throw error
  }

  let output = ""
  let timedOut = false
  let aborted: string | null = null
  const sink = (chunk: string) => {
    output += chunk
    if (output.length > MAX_CAPTURED_OUTPUT + 64 * 1024) {
      output =
        output.slice(0, OUTPUT_HEAD) +
        "\n[moat] output truncated by the host\n" +
        output.slice(-OUTPUT_TAIL)
    }
    opts.onOutput?.(chunk)
    // Checked when a *line* has arrived, not per byte and not on a byte threshold: a byte gate
    // skips the check that matters whenever the runtime's events are small, and re-parsing on every
    // byte would make a long turn quadratic. A newline is exactly when a report could have changed.
    if (opts.abortWhen && aborted === null && chunk.includes("\n")) {
      const reason = opts.abortWhen(output)
      if (reason !== null) {
        aborted = reason
        // --kill-child takes the whole namespace with it, so the agent cannot outlive the ceiling.
        child.kill("SIGKILL")
      }
    }
  }
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", sink)
  child.stderr.on("data", sink)
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true
        // unshare --kill-child takes the namespace down with it.
        child.kill("SIGKILL")
      }, opts.timeoutMs)
    : null

  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      stopDatapath()
    }
    child.on("error", (error) => {
      cleanup()
      reject(error)
    })
    child.on("close", (code) => {
      cleanup()
      resolve({ code: code ?? -1, output, timedOut, ...(aborted ? { aborted } : {}) })
    })
  })
}

/**
 * Run an interactive script in a boot of the sandbox, with the terminal
 * inherited (used by moat shell and the session /shell).
 */
export async function runInteractive(
  p: EnvPaths,
  innerBody: string,
  opts: SandboxRunOptions = {},
): Promise<number> {
  const containerBackend = opts.backend === "container"
  const isolated = containerBackend ? false : bootIsolation(opts)
  const inner = writeInnerScript(p, innerBody)
  const boot = containerBackend
    ? ""
    : writeOuterScript(p, {
        innerScript: inner,
        waitForTap: isolated,
        waitForLink: opts.egressProxy ? VETH_BOX_IFACE : undefined,
        egressRules: opts.egressRules,
      })
  // An interactive boot is the one case where the terminal type has to come from the terminal:
  // TERM=dumb makes Codex's TUI ask "Continue anyway?" before it starts. A container gets it as an
  // --env argument like every other variable; the unshare path puts it in the process environment.
  const plan = bootCommand(p, {
    backend: opts.backend,
    inner,
    outer: boot,
    egress: opts.egress,
    env: { TERM: interactiveTerm(), ...opts.env, ...(opts.egressProxy ? proxyEnv() : {}) },
    isolated,
    egressRules: opts.egressRules,
  })
  const child = spawn(plan.command, plan.args, {
    stdio: "inherit",
    env: plan.env,
  })
  let slirp: { stop: () => void } | null = null
  let proxy: { stop: () => void } | null = null
  let proxySlirp: { stop: () => void } | null = null
  let topology: { stop: () => void } | null = null
  const stopDatapath = (): void => {
    proxy?.stop()
    proxySlirp?.stop()
    slirp?.stop()
    // Last, so the processes that depend on the link are gone before the link is.
    topology?.stop()
  }
  try {
    if (plan.needsSlirp) {
      const egress = await import("./egress.ts")
      const ready = child.pid ? await waitForNewNetns(child.pid) : false
      if (!ready) throw new Error("the sandbox did not enter its network namespace")
      slirp = await egress.startSlirp(opts.slirpBinary!, child.pid!, { logFile: path.join(p.logs, "slirp.log") })
      if (opts.egressProxy) {
        // The proxy gets a namespace of its own with its own datapath, because a process inside the
        // box's namespace is subject to the box's ruleset — and the ruleset's addresses were resolved
        // at boot, which is the very snapshot this exists to retire. Measured both ways in
        // docs/EGRESS.md §7. The box keeps its own datapath and ruleset as the backstop for traffic
        // that ignores the proxy.
        const proxies = await import("./proxy.ts")
        const nets = await import("./proxy-netns.ts")
        const proxyLog = path.join(p.logs, "proxy.log")
        const built = await nets.startProxyNetns(child.pid!, { dir: p.logs, logFile: proxyLog })
        topology = built
        const datapath = await egress.startSlirp(opts.slirpBinary!, built.holderPid, {
          logFile: path.join(p.logs, "slirp-proxy.log"),
        })
        if (!datapath.pid || datapath.pid <= 0) {
          const reason = datapath.error()?.message ?? "the process did not start"
          throw new Error(`could not start the proxy's datapath (${opts.slirpBinary}): ${reason}`)
        }
        proxySlirp = datapath
        const handle = proxies.startEgressProxy(built.holderPid, {
          allow: opts.egressProxy.allow,
          logFile: proxyLog,
          bind: proxies.PROXY_ADDRESS,
          // slirp's resolver, sited in the namespace the proxy's traffic actually leaves from.
          dns: egress.SLIRP_DNS,
        })
        if (!handle.pid || handle.pid <= 0) {
          const reason = handle.error()?.message ?? "the process did not start"
          throw new Error(`could not start the egress proxy (${proxies.NSENTER}): ${reason}`)
        }
        proxy = handle
        if (!(await proxies.waitForProxyListening(proxyLog))) {
          throw new Error("the egress proxy did not report that it was listening")
        }
      }
    }
  } catch (error) {
    stopDatapath()
    child.kill("SIGKILL")
    throw error
  }
  return await new Promise<number>((resolve, reject) => {
    child.on("error", (error) => {
      stopDatapath()
      reject(error)
    })
    child.on("close", (code) => {
      stopDatapath()
      resolve(code ?? 0)
    })
  })
}

export type SandboxProcess = {
  child: ChildProcess
  pid: number
  /** Identity of the process we started, so a reused pid is never signalled. */
  startTime: string | null
  logFile: string
  /** The datapath process when egress is isolated, recorded so down can clean it up. */
  slirp: { pid: number; startTime: string | null } | null
}

export type SandboxStartOptions = {
  /** Which backend boots this box: the default `unshare` path, or a container runtime. */
  backend?: BackendId
  egress?: EgressMode
  /** Path to the slirp4netns binary; required when egress is isolated. */
  slirpBinary?: string
  /** Path inside the sandbox of the nftables ruleset; required when filtered. */
  egressRules?: string
}

/** Boot the sandbox as a long-running server, detached into its own process group. */
export async function startSandbox(
  p: EnvPaths,
  innerBody: string,
  env: SandboxEnv,
  opts: SandboxStartOptions = {},
): Promise<SandboxProcess> {
  const containerBackend = opts.backend === "container"
  const isolated = containerBackend ? false : bootIsolation(opts)
  const inner = writeInnerScript(p, innerBody)
  // The boot log lives inside the rootfs, so the long-running box never holds an append fd on a
  // host file outside itself — opened here, through the guard. The unshare path passes it to the
  // boot script as fd 3, which the script dups; a container has no boot script to hand it to, so
  // the *host* mirrors what the runtime prints into that same file. Either way the box holds no
  // host descriptor, and `moat logs sandbox` reads the same path.
  const bootFd = openRootfsFileForAppend(p.rootfs, "/var/log/moat/boot.log", 0o600)
  const boot = containerBackend
    ? ""
    : writeOuterScript(p, { innerScript: inner, bootLog: true, waitForTap: isolated, egressRules: opts.egressRules })
  fs.mkdirSync(p.logs, { recursive: true })
  const logFile = path.join(p.logs, "sandbox.log")
  const fd = fs.openSync(logFile, "a", 0o600)
  // Only the long-running box is named: everything else boots alongside it.
  const plan = bootCommand(p, {
    backend: opts.backend,
    inner,
    outer: boot,
    egress: opts.egress,
    env,
    isolated,
    egressRules: opts.egressRules,
    name: containerName(p.id),
  })
  // The container writes straight through the *rootfs* descriptor, exactly as the unshare path
  // does — the file is inside the box, so the box holding it is not the thing AGENTS.md forbids
  // (an append fd on a host file **outside** the rootfs).
  //
  // This was a `pipe` + mirror first, and it hung `moat up` forever: a readable pipe with a
  // listener keeps the host's event loop alive, so `unref()` on the child was not enough and the
  // command never exited — with the boot already finished and state.json already written.
  const child = spawn(plan.command, plan.args, {
    env: plan.env,
    stdio: containerBackend ? ["ignore", bootFd, bootFd] : ["ignore", fd, fd, bootFd],
    detached: true,
  })
  child.unref()
  fs.closeSync(fd)
  fs.closeSync(bootFd)
  if (!child.pid) throw new Error("failed to spawn sandbox: no pid")

  let slirp: SandboxProcess["slirp"] = null
  if (plan.needsSlirp) {
    const egress = await import("./egress.ts")
    const ready = await waitForNewNetns(child.pid)
    if (!ready) {
      child.kill("SIGKILL")
      throw new Error("the sandbox did not enter its network namespace")
    }
    const handle = egress.startSlirp(opts.slirpBinary!, child.pid, {
      logFile: path.join(p.logs, "slirp.log"),
    })
    // `spawn` does not throw for a missing or non-executable file: it leaves
    // `child.pid` undefined and delivers the error on the next tick. Measured: pid
    // is undefined *synchronously*, so this check catches the case without waiting.
    // Before it, a datapath that never started was recorded as pid -1 and the
    // failure surfaced much later as "tap0 did not appear" from inside the box,
    // with the reason nowhere.
    if (!handle.pid || handle.pid <= 0) {
      const reason = handle.error()?.message ?? "the process did not start"
      child.kill("SIGKILL")
      throw new Error(`could not start the egress datapath (${opts.slirpBinary}): ${reason}`)
    }
    slirp = { pid: handle.pid, startTime: processStartTime(handle.pid) }
  }

  return { child, pid: child.pid, startTime: processStartTime(child.pid), logFile, slirp }
}

/**
 * The line the entry script prints when the box is genuinely up.
 *
 * `codexEntryScript` (cmd/main.ts) writes it after the mounts, the chroot and the
 * runtime are all in place, and a boot that fails before it never reaches it.
 */
export const READY_MARKER = "[moat] runtime ready"

/**
 * Wait until the box has actually said it is up, and refuse to report a boot that
 * died on the way.
 *
 * `moat up` used to declare success as soon as `unshare` had been spawned, because
 * "the codex runtime has no server to wait for". That is true about *servers* and
 * false about *boots*: the entry script's first act after the mounts is to check
 * the credential deadline, and an already-expired credential makes it print
 * "expired before the box started; stopping" and exit 0 in milliseconds. Measured
 * shape of the bug: `moat up` printed "sandbox booted (pid N)", wrote
 * `status: "running"` into state.json, and the process had already exited when the
 * next command looked. The next command then reported a running sandbox that was
 * not there, and `moat exec` in it failed somewhere further away from the cause.
 *
 * Resolving on the marker rather than on a fixed sleep means a fast boot is not
 * slowed down and a slow one is not cut off; `deadlineMs` is the budget for a
 * *stuck* boot, not for a normal one.
 */
export async function waitForSandboxReady(
  pid: number,
  readLog: () => string | null,
  opts: { deadlineMs?: number; pollMs?: number } = {},
): Promise<{ ok: true } | { ok: false; reason: string; log: string | null }> {
  const deadline = Date.now() + (opts.deadlineMs ?? 120_000)
  const pollMs = opts.pollMs ?? 100
  for (;;) {
    const log = readLog()
    if (log !== null && log.includes(READY_MARKER)) return { ok: true }
    if (!isRunning(pid)) {
      // The box is gone. One more read: the last lines are usually written before
      // the process is reaped, and they are the whole explanation.
      const final = readLog()
      return { ok: false, reason: `the sandbox exited during boot (pid ${pid} is gone)`, log: final }
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        reason: `the sandbox did not finish booting within ${Math.round((opts.deadlineMs ?? 120_000) / 1000)}s (pid ${pid} is still running)`,
        log,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * Stop a sandbox by killing its whole process group.
 *
 * The group is created by `detached: true`, so a single negative-pid signal
 * reaches unshare and the boot script together; `--kill-child` on
 * unshare then guarantees the PID-namespace init cannot outlive it.
 */
export type StopSandboxOptions = {
  /** Which backend the box was started with. A container is stopped by its runtime. */
  backend?: BackendId
  timeoutMs?: number
  startTime?: string | null
  envId?: string
  /** slirp4netns process belonging to this environment, if any. */
  slirpPid?: number | null
  slirpStart?: string | null
}

/**
 * Stop a sandbox and its datapath.
 *
 * The datapath stops after the box, so the tap fd closes first; a recorded
 * slirp pid is only signalled when its start time still matches.
 */
export async function stopSandbox(pid: number, opts: StopSandboxOptions = {}): Promise<boolean> {
  // A container belongs to its runtime, not to the client that started it: signalling the `podman
  // run` process leaves the box running. Measured — `moat down` printed "stopped", wrote
  // `status: stopped`, and the container was still `Up` a minute later.
  if (opts.backend === "container" && opts.envId) {
    const stopped = containerStop(opts.envId)
    // The client is signalled too: it is moat's own child, and leaving it is untidy even though it
    // cannot take the container down by dying.
    await stopSandboxProcess(pid, opts)
    await stopSlirp(opts.slirpPid ?? null, opts.slirpStart ?? null)
    return stopped
  }
  const stopped = await stopSandboxProcess(pid, opts)
  await stopSlirp(opts.slirpPid ?? null, opts.slirpStart ?? null)
  return stopped
}

/**
 * Stop a slirp4netns process; never signal a pid that is no longer ours.
 *
 * Returns true only when it actually signalled a live process whose start time matched.
 * The caller prints "reaped the datapath" on the strength of that: a message that fires
 * when the datapath had already exited on its own would be a small lie.
 */
export async function stopSlirp(pid: number | null, startTime: string | null): Promise<boolean> {
  if (!pid || !isRunning(pid)) return false
  if (startTime && processStartTime(pid) !== startTime) return false
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return false
  }
  for (let i = 0; i < 20; i += 1) {
    if (!isRunning(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    /* already gone */
  }
  return true
}

async function stopSandboxProcess(pid: number, opts: StopSandboxOptions): Promise<boolean> {
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
