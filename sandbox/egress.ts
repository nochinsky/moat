import fs from "node:fs"
import net from "node:net"
import { spawn, type ChildProcess } from "node:child_process"

import { slirpCachePath } from "../lib/paths.ts"
import { SLIRP4NETNS_SHA256, SLIRP4NETNS_URL, SLIRP_DNS } from "../lib/pins.ts"
import { download } from "./rootfs.ts"

import type { EgressMode } from "../lib/pins.ts"
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

/**
 * What a fresh boot of an environment with this policy needs: the policy, and
 * the datapath binary when it is isolated.
 */
export async function runtimeForEgress(egress: EgressMode): Promise<{ egress: EgressMode; slirpBinary?: string }> {
  if (egress !== "isolated") return { egress }
  return { egress, slirpBinary: await ensureSlirp4netns() }
}

/**
 * Ask slirp4netns to forward a host loopback port into the sandbox.
 *
 * slirp has no command-line port forwarding; the documented path is its API
 * socket, which is what rootlesskit uses too. The request never leaves the Unix
 * socket, and the reply is the RPC result.
 */
export function addHostForward(apiSocket: string, port: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(apiSocket)
    let buffer = ""
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("slirp4netns did not answer the add_hostfwd request"))
    }, timeoutMs)
    const finish = (error?: Error) => {
      clearTimeout(timer)
      socket.end()
      if (error) reject(error)
      else resolve()
    }
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
      finish(reply.error ? new Error(`slirp4netns refused the port forward: ${buffer.trim()}`) : undefined)
    })
    socket.on("error", (error) => finish(error))
  })
}

/** Wait for a Unix socket to exist, or for the process that should create it to die. */
async function waitForSocket(socketPath: string, timeoutMs: number, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return true
    if (child.exitCode !== null) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return fs.existsSync(socketPath)
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
