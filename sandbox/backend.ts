import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import type { EnvPaths } from "../lib/paths.ts"
import type { EgressMode } from "../lib/pins.ts"

/**
 * How a box is started: `unshare` directly, or a container runtime.
 *
 * This is the seam Phase 4 measured its way to (`docs/PORTABILITY.md` §2). It is deliberately narrow:
 * a backend answers one question — *what command, with what environment, runs this script against
 * this rootfs* — and everything else moat does (the rootfs is a directory, the config is rendered
 * into it, `/work` lives inside it, copy-out is git) is unchanged, because the container backend was
 * measured to give all of it.
 *
 * What the container backend was measured to provide, on a rootless host (`test/evidence/portability-podman.txt`):
 *
 *  - `--rootfs` takes a **plain directory**, uid 0 inside, and a write inside **persists** into it;
 *  - all six namespaces differ from the host's, as `moat doctor` already asserts;
 *  - `/dev` is populated by the runtime, so the six host device binds are not needed at all;
 *  - the host's home is not inside, and the **host's loopback is refused** — so the datapath that
 *    moat currently runs (`slirp4netns`) is not needed either.
 *
 * The last one is why `needsSlirp` exists and is false here: the isolation moat's own datapath
 * provides with `--disable-host-loopback` is the runtime's default.
 */

export type BackendId = "unshare" | "container"

export type BootPlan = {
  command: string
  args: string[]
  /**
   * True when moat must start its own userspace datapath for this boot.
   *
   * Only the `unshare` backend with its own network namespace needs one. A container runtime brings
   * its own, and closes the host's loopback by default — measured, see the module comment.
   */
  needsSlirp: boolean
  /** A word for the report and for `moat doctor`. */
  label: string
}

export const DEFAULT_BACKEND: BackendId = "unshare"

export const BACKEND_IDS: readonly BackendId[] = ["unshare", "container"]

export function resolveBackend(id: string): BackendId {
  if (id === "unshare" || id === "container") return id
  throw new Error(`unknown backend "${id}". moat ships: ${BACKEND_IDS.join(", ")}.`)
}

/** Is the container runtime moat would use actually present and usable by this user? */
export function containerRuntime(): { command: string; usable: boolean } {
  for (const candidate of ["podman", "docker"]) {
    const found = which(candidate)
    if (found) return { command: found, usable: true }
  }
  return { command: "podman", usable: false }
}

function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      /* not here */
    }
  }
  return null
}

/**
 * The network a boot gets.
 *
 * `open` is the host's namespace, and a container says that with `--network=host` — the same thing
 * moat means by it, and the same warning applies: every service on the host's loopback is reachable.
 *
 * Both other modes are the runtime's **default** network. That is not a shortcut: measured on a
 * rootless host, a default container reaches the outside world and is **refused** on the host's
 * `127.0.0.1`, which is exactly the property moat's `slirp4netns --disable-host-loopback` datapath
 * exists to provide. `filtered` adds moat's nftables ruleset on top of it, applied inside the box as
 * it is today.
 */
function networkArgs(egress: EgressMode | undefined): string[] {
  return egress === "open" ? ["--network=host"] : []
}

/**
 * The container's name, derived from the environment id.
 *
 * Derived rather than stored, so `moat down` and `moat status` can find the box without a second
 * piece of state that could disagree with the first. Killing the `podman run` *client* does not stop
 * the container — conmon owns it — which is exactly how a `moat down` under this backend left a box
 * running while state.json said stopped.
 */
export function containerName(envId: string): string {
  return `moat-${envId}`
}

/** Is the container for this environment running? */
export function containerRunning(envId: string): boolean {
  const runtime = containerRuntime()
  if (!runtime.usable) return false
  const result = spawnSync(runtime.command, ["inspect", "--format", "{{.State.Running}}", containerName(envId)], {
    encoding: "utf8",
  })
  return result.status === 0 && (result.stdout ?? "").trim() === "true"
}

/**
 * Stop the box through the runtime, which is the only thing that can.
 *
 * `rm -f` rather than `stop` then `rm`: the boot runs with `--rm`, so a stopped container is
 * already gone, and `rm -f` covers both states without a race between them.
 */
export function containerStop(envId: string): boolean {
  const runtime = containerRuntime()
  if (!runtime.usable) return false
  const result = spawnSync(runtime.command, ["rm", "-f", containerName(envId)], { encoding: "utf8" })
  return result.status === 0
}

export type ContainerPlanOptions = {
  /**
   * A stable name, for the long-running box only.
   *
   * Ephemeral boots must NOT be named: moat runs them *alongside* the box by design — a task, a
   * check, `moat exec` and `moat doctor` each take their own boot of the same rootfs — so a name
   * derived from the environment id collides with the keepalive. Measured: the second one failed
   * with "the container name `moat-<id>` is already in use", which surfaced as podman's exit code
   * 125 in the middle of a task.
   */
  name?: string
  egress?: EgressMode
  /** The box's environment: configuration and the credential variable, never a file. */
  env?: Record<string, string | undefined>
}

/**
 * The command that runs `innerScript` against `rootfs` under a container runtime.
 *
 * `innerScript` is the host path of the script written *inside* the rootfs by `writeInnerScript`,
 * so the in-container path is the suffix after the rootfs. There is no outer script here: the mount
 * table, the chroot and the device nodes are the runtime's job, which is the whole reason this
 * backend is worth having.
 */
export function containerPlan(p: EnvPaths, innerScript: string, opts: ContainerPlanOptions = {}): BootPlan {
  const runtime = containerRuntime()
  const inner = "/" + path.posix.relative(p.rootfs, innerScript)
  // `--rootfs` is a BOOLEAN flag: it says "the first argument is not an image but the rootfs", so
  // the path is a *positional* and every option has to come before it. Putting `--rootfs <dir>`
  // first made the options that followed part of the command — measured, crun reported
  // "executable file `--env` not found in $PATH". The order below is the contract.
  const args = ["run", "--rm", ...(opts.name ? ["--name", opts.name] : []), ...networkArgs(opts.egress)]
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) continue
    args.push("--env", `${key}=${value}`)
  }
  args.push("--rootfs", p.rootfs, "/bin/sh", inner)
  return { command: runtime.command, args, needsSlirp: false, label: runtime.command }
}
