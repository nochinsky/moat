import fs from "node:fs"
import { spawn, type ChildProcess } from "node:child_process"

import { slirpCachePath } from "../lib/paths.ts"
import { SLIRP4NETNS_SHA256, SLIRP4NETNS_URL } from "../lib/pins.ts"
import { download } from "./rootfs.ts"

/**
 * The userspace datapath for a sandbox with its own network namespace.
 *
 * A rootless process can create a network namespace it owns, but it cannot NAT
 * inside it without help. slirp4netns is that help: it attaches a tap to the
 * sandbox's namespace and carries packets through a userspace TCP/IP stack, so
 * the sandbox keeps an outbound network while losing the host's network
 * position. The host reaches opencode serve through an explicit port forward
 * rather than the shared loopback.
 *
 * The binary is fetched once, verified against the published SHA-256, and
 * cached beside the other host artefacts.
 */

/** Fetch (or reuse) the static slirp4netns binary. */
export async function ensureSlirp4netns(): Promise<string> {
  const dest = slirpCachePath()
  await download(SLIRP4NETNS_URL, dest, { sha256: SLIRP4NETNS_SHA256 })
  fs.chmodSync(dest, 0o755)
  return dest
}

/**
 * slirp4netns arguments for one sandbox.
 *
 * --configure makes slirp set the tap up and hand back its fd; -p forwards the
 * host's loopback port to the same port inside the namespace, which is how the
 * host still talks to opencode. The guest must listen on its tap address rather
 * than 127.0.0.1 for the forward to reach it.
 */
export function slirpArgs(sandboxPid: number, port: number): string[] {
  return ["--configure", "--mtu=65520", "-p", "127.0.0.1:" + port + ":" + port, String(sandboxPid), "tap0"]
}

export type SlirpHandle = {
  child: ChildProcess
  pid: number
  stop: () => void
}

/** Start slirp4netns against a live sandbox process. */
export function startSlirp(binary: string, sandboxPid: number, port: number): SlirpHandle {
  const child = spawn(binary, slirpArgs(sandboxPid, port), { stdio: ["ignore", "ignore", "pipe"] })
  child.on("error", () => {
    /* the readiness check inside the box reports a missing tap */
  })
  child.unref()
  return {
    child,
    pid: child.pid ?? -1,
    stop: () => {
      try {
        child.kill("SIGTERM")
      } catch {
        /* already gone */
      }
    },
  }
}

/**
 * The resolver an isolated sandbox needs.
 *
 * slirp4netns answers DNS at 10.0.2.3 inside the namespace; the host's resolver
 * is not reachable once the sandbox has its own network namespace.
 */
export const SLIRP_DNS = "10.0.2.3"
export const SLIRP_NAMESERVER_LINE = "nameserver " + SLIRP_DNS + "\n"
