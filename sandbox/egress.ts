import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import dns from "node:dns"
import { spawn, type ChildProcess } from "node:child_process"

import { slirpCachePath } from "../lib/paths.ts"
import {
  EGRESS_ALLOWED_PORTS,
  EGRESS_REGISTRY_HOSTS,
  SLIRP4NETNS_SHA256,
  SLIRP4NETNS_URL,
  SLIRP_DNS,
} from "../lib/pins.ts"
import { download } from "./rootfs.ts"

import type { EgressMode } from "../lib/pins.ts"
import { ensureRootfsDir, writeRootfsFile } from "../lib/rootfs-fs.ts"
export type { EgressMode }
export { SLIRP_DNS }

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
export function slirpArgs(sandboxPid: number, opts: { apiSocket?: string } = {}): string[] {
  const args = ["--configure", "--mtu=65520"]
  // Without this, slirp's 10.0.2.2 gateway forwards straight to the host's
  // loopback: a sandbox in its own namespace could still reach every service the
  // host runs. Measured: default slirp answers HTTP 200 on 10.0.2.2:<host port>,
  // and this flag makes it a refusal.
  args.push("--disable-host-loopback")
  if (opts.apiSocket) args.push("--api-socket", opts.apiSocket)
  args.push(String(sandboxPid), "tap0")
  return args
}

export type SlirpHandle = {
  child: ChildProcess
  pid: number
  apiSocket: string
  stop: () => void
}

/** Split `--egress-allow` into hostnames or IPv4 literals, without duplicates. */
export function parseAllowlist(value: string | undefined): string[] {
  if (!value) return []
  return [...new Set(value.split(/[,\s]+/).map((item) => item.trim().toLowerCase()).filter(Boolean))]
}

/**
 * Why this allowlist entry cannot work, or null when it is usable.
 *
 * The resolver drops anything that is not a name or an address, which is the
 * worst possible outcome for a security flag: `--egress-allow
 * https://internal.example` looked accepted, the boot succeeded, and the box then
 * could not reach what the user believed they had allowed. Say why instead.
 */
export function allowHostProblem(host: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) return "that is a URL; give the hostname only"
  if (host.includes("/")) return "CIDR ranges and paths are not supported; name each host"
  if (host.includes("*")) return "wildcards cannot be resolved; name each host"
  if (host.startsWith("[")) return host.endsWith("]") ? null : "that bracket is unbalanced"
  const colons = host.split(":").length - 1
  if (colons === 1) return "only ports 80 and 443 are allowed, and ports cannot be scoped per host"
  if (colons >= 2) return null // a bare IPv6 literal
  if (!/^[a-z0-9._-]+$/.test(host)) return "that is not a hostname or an IP address"
  return null
}

/** The default allowlist: the package sources every profile may need, plus the provider. */
export function defaultAllowHosts(providerHost?: string): string[] {
  const hosts = [...EGRESS_REGISTRY_HOSTS]
  if (providerHost) hosts.push(providerHost)
  return [...new Set(hosts)]
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

export type AllowlistResolution = {
  addresses: string[]
  /** Hosts that resolved to nothing. The box will not reach them. */
  unresolved: string[]
}

/**
 * Turn hostnames into the addresses the ruleset allows, and say which ones
 * failed.
 *
 * Resolution happens on the host at boot. A host that does not resolve is
 * dropped from the ruleset rather than failing the boot — but dropping it
 * silently is how a box ends up filtered with an allowlist that cannot reach the
 * provider, booting happily and failing only when the agent calls the model.
 * Callers decide what an unresolved host costs; this reports it.
 */
export async function resolveAllowlistDetailed(
  hosts: string[],
  lookup?: (host: string) => Promise<string[]>,
): Promise<AllowlistResolution> {
  const resolve =
    lookup ??
    (async (host: string) =>
      (await dns.promises.lookup(host, { all: true, family: 4 })).map((entry) => entry.address))
  const ips = new Set<string>()
  const unresolved: string[] = []
  for (const host of hosts) {
    if (IPV4.test(host)) {
      ips.add(host)
      continue
    }
    try {
      const addresses = await resolve(host)
      if (addresses.length === 0) unresolved.push(host)
      for (const ip of addresses) ips.add(ip)
    } catch {
      unresolved.push(host)
    }
  }
  return { addresses: [...ips].sort(), unresolved }
}

/** The addresses only. Kept for callers that do not report the failures. */
export async function resolveAllowlist(
  hosts: string[],
  lookup?: (host: string) => Promise<string[]>,
): Promise<string[]> {
  return (await resolveAllowlistDetailed(hosts, lookup)).addresses
}

/**
 * The nftables ruleset for a filtered sandbox.
 *
 * It is applied inside the sandbox's own network namespace, which moat owns, so
 * the unprivileged process holds CAP_NET_ADMIN there. Everything is dropped by
 * default: loopback, replies to connections the sandbox opened, DNS to slirp's
 * resolver, and TCP 80/443 to the resolved allowlist are the only exceptions.
 */
export function renderNftRules(ips: string[], dnsIp: string = SLIRP_DNS): string {
  const ports = EGRESS_ALLOWED_PORTS.join(", ")
  const lines = [
    "# generated by moat: default-deny egress for a sandbox in its own network namespace",
    "table inet moat_egress {",
  ]
  if (ips.length > 0) {
    lines.push("  set allowed4 {")
    lines.push("    type ipv4_addr")
    lines.push("    flags interval")
    lines.push("    elements = { " + ips.join(", ") + " }")
    lines.push("  }")
  }
  lines.push("  chain output {")
  lines.push("    type filter hook output priority 0; policy drop;")
  lines.push("    oif lo accept")
  lines.push("    ct state established,related accept")
  if (ips.length > 0) lines.push("    ip daddr @allowed4 tcp dport { " + ports + " } accept")
  lines.push("    ip daddr " + dnsIp + " udp dport 53 accept")
  lines.push("    ip daddr " + dnsIp + " tcp dport 53 accept")
  lines.push("  }")
  lines.push("}")
  return lines.join("\n") + "\n"
}

/**
 * Write the ruleset where the boot script applies it, and return its path
 * inside the sandbox. Resolution happens on every call, so a fresh boot picks
 * up addresses that have rotated since the environment was created.
 */
export async function ensureEgressPolicy(
  rootfs: string,
  hostnames: string[],
): Promise<{ path: string; unresolved: string[] }> {
  const { addresses, unresolved } = await resolveAllowlistDetailed(hostnames)
  ensureRootfsDir(rootfs, "/.moat")
  writeRootfsFile(rootfs, "/.moat/egress.nft", renderNftRules(addresses), 0o644)
  return { path: "/.moat/egress.nft", unresolved }
}

export type EgressRuntime = {
  egress: EgressMode
  slirpBinary?: string
  /** Path inside the sandbox of the ruleset the boot script must apply. */
  egressRules?: string
  /** Allowlist hosts that resolved to nothing, so the caller can say so. */
  unresolved?: string[]
}

/**
 * What a fresh boot of an environment with this policy needs: the datapath
 * binary for any isolated mode, and the ruleset for a filtered one.
 */
export async function runtimeForEgress(
  egress: EgressMode,
  opts: { rootfs?: string; allowHosts?: string[] } = {},
): Promise<EgressRuntime> {
  if (egress === "open") return { egress }
  const slirpBinary = await ensureSlirp4netns()
  if (egress !== "filtered" || !opts.rootfs) return { egress, slirpBinary }
  const policy = await ensureEgressPolicy(opts.rootfs, opts.allowHosts ?? [])
  return { egress, slirpBinary, egressRules: policy.path, unresolved: policy.unresolved }
}

/**
 * Ask slirp4netns to forward a host loopback port into the sandbox.
 *
 * slirp has no command-line port forwarding; the documented path is its API
 * socket, which is what rootlesskit uses too. The request never leaves the Unix
 * socket, and the reply is the RPC result.
 */
export async function addHostForward(apiSocket: string, port: number, timeoutMs = 5000): Promise<void> {
  // Connecting can fail transiently even when slirp is healthy: its API socket
  // has a one-connection accept queue, and the readiness probe above may still be
  // sitting in it when this connect arrives (measured: "connect EAGAIN" on a boot
  // that then succeeded on the next attempt). A reply that refuses the forward is
  // final; a connect that never reached slirp is worth another attempt.
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await forwardOnce(apiSocket, port, Math.max(200, deadline - Date.now()))
    if (result === "done") return
    if (Date.now() >= deadline) throw new Error("slirp4netns did not accept the add_hostfwd request")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** One attempt. Resolves "retry" when the connection never reached slirp. */
function forwardOnce(apiSocket: string, port: number, timeoutMs: number): Promise<"done" | "retry"> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(apiSocket)
    let buffer = ""
    let sawReply = false
    let settled = false
    const settle = (result: "done" | "retry", error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.end()
      if (error) reject(error)
      else resolve(result)
    }
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("slirp4netns did not answer the add_hostfwd request"))
    }, timeoutMs)
    socket.on("connect", () => {
      socket.write(
        JSON.stringify({
          execute: "add_hostfwd",
          arguments: { proto: "tcp", host_addr: "127.0.0.1", host_port: port, guest_port: port },
        }) + "\n",
      )
    })
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      // slirp answers with one JSON object and no trailing newline; a partial
      // read simply fails to parse and the next chunk is appended.
      let reply: { error?: unknown }
      try {
        reply = JSON.parse(buffer) as { error?: unknown }
      } catch {
        return
      }
      sawReply = true
      if (reply.error) settle("done", new Error(`slirp4netns refused the port forward: ${buffer.trim()}`))
      else settle("done")
    })
    socket.on("error", (error) => {
      if (sawReply) settle("done", error)
      else settle("retry")
    })
  })
}

/**
 * What is behind this Unix socket: a listener, a corpse, or something we cannot
 * tell?
 *
 * "unknown" matters for pruning. EAGAIN means the accept queue is full, which is
 * what a *live* socket looks like from here, so treating it as dead would unlink
 * a running slirp's socket and make it unreachable for the rest of its life.
 */
export async function socketState(socketPath: string, timeoutMs = 250): Promise<"live" | "dead" | "unknown"> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath)
    let settled = false
    const finish = (state: "live" | "dead" | "unknown") => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(state)
    }
    const timer = setTimeout(() => finish("unknown"), timeoutMs)
    socket.on("connect", () => finish("live"))
    socket.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "dead" : "unknown")
    })
  })
}

/** Can a client connect to this Unix socket right now? */
export async function socketAccepts(socketPath: string, timeoutMs = 250): Promise<boolean> {
  return (await socketState(socketPath, timeoutMs)) === "live"
}

/**
 * Wait until the API socket accepts connections, or the process that should
 * create it dies.
 *
 * Existence is not readiness. A socket file outlives the slirp that created it
 * (SIGTERM does not unlink it), so a restart that only stat()ed the path
 * connected to the previous boot's corpse and failed with ECONNREFUSED — while
 * slirp itself could not bind over the stale file at all.
 */
export async function waitForSocket(
  socketPath: string,
  timeoutMs: number,
  child: { exitCode: number | null },
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await socketAccepts(socketPath)) return true
    if (child.exitCode !== null) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return socketAccepts(socketPath)
}

/**
 * Reap API sockets in this directory that nothing is listening on.
 *
 * Each boot gets its own socket name, so a dead one is never reused; this is
 * only housekeeping. A live socket is never removed, so a concurrent boot of
 * another environment cannot have its datapath yanked out from under it.
 */
export async function pruneDeadSockets(dir: string): Promise<void> {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!/^slirp-.*\.sock$/.test(name)) continue
    const full = path.join(dir, name)
    // Only a definitive "nothing is listening" justifies unlinking: an ambiguous
    // failure (a full accept queue, a transient EMFILE) must keep the file, or a
    // live box loses the socket its next forward would need.
    if ((await socketState(full)) !== "dead") continue
    fs.rmSync(full, { force: true })
  }
}

export type StartSlirpOptions = {
  apiSocket: string
  /** Host loopback port to forward to the same port inside the namespace. */
  port?: number
  /** Collect slirp's stderr here; when the tap never appears, that is where the reason is. */
  logFile?: string
}

/**
 * Start slirp4netns against a live sandbox process and wait until the datapath
 * is usable (and, when asked, the server port is forwarded).
 */
export async function startSlirp(
  binary: string,
  sandboxPid: number,
  opts: StartSlirpOptions,
): Promise<SlirpHandle> {
  // slirp cannot bind over a socket file a previous boot left behind, and the
  // readiness check below must never mistake that corpse for this boot's socket.
  await pruneDeadSockets(path.dirname(opts.apiSocket))
  const err: "ignore" | number = opts.logFile ? fs.openSync(opts.logFile, "a") : "ignore"
  const child = spawn(binary, slirpArgs(sandboxPid, { apiSocket: opts.apiSocket }), {
    stdio: ["ignore", "ignore", err],
  })
  if (typeof err === "number") fs.closeSync(err)
  child.on("error", () => {
    /* the readiness check inside the box reports a missing tap */
  })
  child.unref()
  const stop = () => {
    try {
      child.kill("SIGTERM")
    } catch {
      /* already gone */
    }
    try {
      fs.rmSync(opts.apiSocket, { force: true })
    } catch {
      /* already gone */
    }
  }
  if (opts.port !== undefined) {
    try {
      // The socket appears asynchronously, and slirp can also exit first (a
      // stale socket path, a bad target). Waiting here turns both into a clear
      // error instead of an ENOENT from the first connect.
      const ready = await waitForSocket(opts.apiSocket, 5000, child)
      if (!ready) throw new Error(`slirp4netns did not create ${opts.apiSocket}${opts.logFile ? `; see ${opts.logFile}` : ""}`)
      await addHostForward(opts.apiSocket, opts.port)
    } catch (error) {
      stop()
      throw error
    }
  }
  return { child, pid: child.pid ?? -1, apiSocket: opts.apiSocket, stop }
}

/**
 * The resolver an isolated sandbox needs.
 *
 * slirp4netns answers DNS at 10.0.2.3 inside the namespace; the host's resolver
 * is not reachable once the sandbox has its own network namespace.
 */
export const SLIRP_NAMESERVER_LINE = "nameserver " + SLIRP_DNS + "\n"
