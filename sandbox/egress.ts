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
 * the sandbox keeps an outbound network while losing the host's network position and the
 * host's loopback. Nothing is forwarded in: the host never talks to a port inside the box,
 * because there is no server in there to talk to.
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
 * --configure makes slirp set the tap up inside the sandbox's namespace and hand back its fd.
 * There is no --api-socket and no forward: that socket exists to add host forwards, and the
 * host has nothing in the box to forward to.
 */
export function slirpArgs(sandboxPid: number): string[] {
  const args = ["--configure", "--mtu=65520"]
  // Without this, slirp's 10.0.2.2 gateway forwards straight to the host's
  // loopback: a sandbox in its own namespace could still reach every service the
  // host runs. Measured: default slirp answers HTTP 200 on 10.0.2.2:<host port>,
  // and this flag makes it a refusal.
  args.push("--disable-host-loopback")
  args.push(String(sandboxPid), "tap0")
  return args
}

export type SlirpHandle = {
  child: ChildProcess
  pid: number
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
 * Resolve the allowlist and render the ruleset the boot script will apply.
 *
 * The ruleset is *returned as text*, not written into the rootfs. It used to be a
 * file at `/.moat/egress.nft` inside the sandbox, which the agent is root enough
 * to rewrite between boots: the next boot would apply whatever policy the box had
 * left there and come up "filtered" under rules the agent chose, with the boot
 * log reporting success. The boot script lives outside the rootfs, so the policy
 * travels with it and there is no path for the box to edit.
 *
 * Resolution happens on every call, so a fresh boot picks up addresses that have
 * rotated since the environment was created.
 */
export async function ensureEgressPolicy(
  hostnames: string[],
): Promise<{ rules: string; unresolved: string[] }> {
  const { addresses, unresolved } = await resolveAllowlistDetailed(hostnames)
  return { rules: renderNftRules(addresses), unresolved }
}

export type EgressRuntime = {
  egress: EgressMode
  slirpBinary?: string
  /** The ruleset the boot script must apply, as text. */
  egressRules?: string
  /** Allowlist hosts that resolved to nothing, so the caller can say so. */
  unresolved?: string[]
}

/**
 * What a fresh boot of an environment with this policy needs: the datapath
 * binary for any isolated mode, and the ruleset for a filtered one.
 *
 * `rootfs` is no longer needed to write into, and is only kept so a caller that
 * has one does not have to change; the ruleset never touches the box.
 */
export async function runtimeForEgress(
  egress: EgressMode,
  opts: { rootfs?: string; allowHosts?: string[] } = {},
): Promise<EgressRuntime> {
  if (egress === "open") return { egress }
  const slirpBinary = await ensureSlirp4netns()
  if (egress !== "filtered") return { egress, slirpBinary }
  const policy = await ensureEgressPolicy(opts.allowHosts ?? [])
  return { egress, slirpBinary, egressRules: policy.rules, unresolved: policy.unresolved }
}

export type StartSlirpOptions = {
  /** Collect slirp's stderr here; when the tap never appears, that is where the reason is. */
  logFile?: string
}

/**
 * Start slirp4netns against a live sandbox process.
 *
 * Readiness is measured *inside* the box rather than here: the boot probes the network it
 * actually got, and a datapath that never came up fails there with a reason.
 */
export async function startSlirp(binary: string, sandboxPid: number, opts: StartSlirpOptions = {}): Promise<SlirpHandle> {
  const err: "ignore" | number = opts.logFile ? fs.openSync(opts.logFile, "a") : "ignore"
  const child = spawn(binary, slirpArgs(sandboxPid), { stdio: ["ignore", "ignore", err] })
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
  }
  return { child, pid: child.pid ?? -1, stop }
}

/**
 * The resolver an isolated sandbox needs.
 *
 * slirp4netns answers DNS at 10.0.2.3 inside the namespace; the host's resolver
 * is not reachable once the sandbox has its own network namespace.
 */
export const SLIRP_NAMESERVER_LINE = "nameserver " + SLIRP_DNS + "\n"
