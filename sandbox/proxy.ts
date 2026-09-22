import { spawn } from "node:child_process"
import dns from "node:dns"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The egress proxy: one process on the boot's own loopback, which the agent is told to use.
 *
 * This exists because moat's egress policy is an nftables allowlist over addresses resolved at boot,
 * and `AGENTS.md` names what that costs: the allowlist is an IP snapshot (a rotating CDN address
 * falls out until the next `moat up`), it cannot express per-host ports, and DNS to slirp's resolver
 * is still an outbound channel. A proxy that resolves the name itself and admits or refuses by
 * name and port before dialing closes all three.
 *
 * The placement is measured rather than assumed, and every part of it was taken on a real box
 * (`docs/EGRESS.md` §4, `test/proxy-spike.sh`):
 *
 *  - It listens on the **boot's own loopback**, placed by `nsenter --user --net
 *    --preserve-credentials`. A listener on the host's loopback is unreachable from `isolated` and
 *    `filtered` egress (that is the property `--disable-host-loopback` buys), and one on the host's
 *    *non-loopback* address is reachable from a `unshare` box but not from a container box at all —
 *    so a host-side listener is a one-backend design.
 *  - `--preserve-credentials` is the flag that makes it work: plain `--net` fails, because nsenter
 *    then wants to write `gid_map`. util-linux is the package `unshare` and `chroot` already come
 *    from, so this needs nothing new shipped.
 *  - The agent cannot reach the process: it is not in the box's `/proc`, `kill -0` is refused, and
 *    it survives the box's `kill -TERM` (measured). It shares the box's *user* namespace but not its
 *    pid namespace, and it keeps the host uid — unmapped inside the box.
 *  - A CONNECT tunnel carries the runtime's real TLS: with this proxy in the path, a request to a
 *    real provider came back 401 through the tunnel, and the proxy saw only `host:port`. No
 *    interception, no certificate, no CA in the box — which also means it cannot inject a
 *    credential, and it does not pretend to.
 */

/** One policy entry: `host` (any port) or `host:port`. */
export type ProxyRule = string

/**
 * The port the proxy listens on **inside the boot's network namespace**.
 *
 * Fixed rather than picked per boot, because the box's environment has to name it at spawn and the
 * proxy can only start once the boot has a pid — and a fixed port inside a namespace is a fixed
 * port on its own `127.0.0.1`, so two boxes never contend for it.
 */
export const PROXY_PORT = 41417

/** Split a policy entry into host and optional port, lowercased. */
function parseRule(rule: string): { host: string; port: number | null } | null {
  const text = rule.trim().toLowerCase()
  if (!text) return null
  const index = text.lastIndexOf(":")
  if (index === -1) return { host: text, port: null }
  const port = Number(text.slice(index + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: text.slice(0, index), port }
}

/**
 * Does the policy admit this destination?
 *
 * Exact host, case-insensitive, with an optional port — deliberately not a suffix or glob match,
 * because `evil-api.github.com` matching a rule for `api.github.com` is the mistake this whole
 * component exists to avoid making.
 */
export function allowedTarget(allow: readonly ProxyRule[], host: string, port: number): boolean {
  const wanted = host.trim().toLowerCase()
  for (const rule of allow) {
    const parsed = parseRule(rule)
    if (!parsed) continue
    if (parsed.host === wanted && (parsed.port === null || parsed.port === port)) return true
  }
  return false
}

/**
 * The environment the box needs in order to use the proxy.
 *
 * All three variables, because the clients differ: both runtimes honour them (measured), and an
 * unset `NO_PROXY` in the parent could otherwise exempt a host from the policy. `NO_PROXY` is set to
 * the empty string deliberately — set, so it beats an inherited value, empty so nothing is exempt.
 */
export function proxyEnv(port: number = PROXY_PORT): Record<string, string> {
  const url = `http://127.0.0.1:${port}`
  return { HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, NO_PROXY: "", no_proxy: "" }
}

/** Where this module lives, so the proxy can be run as a program in either layout. */
export function proxyModulePath(): string {
  return fileURLToPath(import.meta.url)
}

/**
 * Place the proxy inside a boot's own network namespace.
 *
 * The pid is the boot's, and the namespace is the one slirp4netns is attached to — the same seam, in
 * the same order: the operator waits for the new namespace before either is started.
 */
export function proxyArgs(
  bootPid: number,
  allow: readonly ProxyRule[],
  logFile: string,
  port: number = PROXY_PORT,
  dnsAddress?: string,
): string[] {
  return [
    "--target",
    String(bootPid),
    "--user",
    "--net",
    "--preserve-credentials",
    "--",
    process.execPath,
    proxyModulePath(),
    "--port",
    String(port),
    "--log",
    logFile,
    // The resolver the *box* can use, passed explicitly. This is not an optimisation: the proxy is
    // a host process in the box's network namespace, so it would otherwise read the host's
    // /etc/resolv.conf — and a filtered box's ruleset admits DNS only to slirp's resolver
    // (10.0.2.3), so the host's nameserver is dropped and every dial fails with EAI_AGAIN.
    // Measured: sandbox/proxy.log read `FAILED api.deepseek.com:443 getaddrinfo EAI_AGAIN`.
    ...(dnsAddress ? ["--dns", dnsAddress] : []),
    ...(allow.length > 0 ? ["--allow", allow.join(",")] : []),
  ]
}

/**
 * Wait until the proxy has said it is listening.
 *
 * The proxy can only start once the boot has a pid, and the agent starts as soon as the boot's
 * readiness line appears — so without this the first request can beat the listener and fail with a
 * connection refusal. The evidence is the proxy's own log line, which it writes from inside
 * `listen`'s callback, rather than a sleep that guesses.
 */
export async function waitForProxyListening(
  logFile: string,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(logFile, "utf8").includes("listening on")) return true
    } catch {
      // Not created yet: that is "not ready", not "failed".
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

/** The `nsenter` binary. It is util-linux, which `unshare` and `chroot` already come from. */
export const NSENTER = "nsenter"

export type EgressProxyHandle = {
  pid: number
  stop: () => void
  error: () => Error | null
}

/**
 * Start the proxy for one boot and return its handle.
 *
 * Mirrors `startSlirp`, including the part that cost real time there: `spawn` does not throw for a
 * missing binary — it leaves `pid` undefined and delivers the error on the next tick — so the caller
 * has to look.
 */
export function startEgressProxy(
  bootPid: number,
  opts: { allow: readonly ProxyRule[]; logFile: string; port?: number; nsenter?: string; dns?: string },
): EgressProxyHandle {
  const port = opts.port ?? PROXY_PORT
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true })
  // The proxy's own log, appended, host-side: it is outside the rootfs, so it is not the
  // box-written log the rootfs guard exists for.
  const fd = fs.openSync(opts.logFile, "a", 0o600)
  const child = spawn(opts.nsenter ?? NSENTER, proxyArgs(bootPid, opts.allow, opts.logFile, port, opts.dns), {
    stdio: ["ignore", fd, fd],
    detached: false,
  })
  fs.closeSync(fd)
  let spawnError: Error | null = null
  child.on("error", (error) => {
    spawnError = error
  })
  return {
    pid: child.pid ?? -1,
    stop: () => {
      try {
        if (child.pid) process.kill(child.pid, "SIGTERM")
      } catch {
        // Already gone: the pid is not an identity, and reaping must not throw.
      }
    },
    error: () => spawnError,
  }
}

// ---------------------------------------------------------------------------
// The proxy itself. Everything below runs only when this file is the program.

type Options = { port: number; allow: ProxyRule[]; log: string | null; dns: string | null }

function proxyOptions(argv: string[]): Options {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  const allow = (value("--allow") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  return {
    port: Number(value("--port") ?? PROXY_PORT),
    allow,
    log: value("--log") ?? null,
    dns: value("--dns") ?? null,
  }
}

function logLine(file: string | null, text: string): void {
  const line = `${new Date().toISOString()} ${text}\n`
  if (file) {
    try {
      fs.appendFileSync(file, line)
      return
    } catch {
      // Fall through to stderr rather than losing the line.
    }
  }
  process.stderr.write(`[moat-proxy] ${line}`)
}

function refuse(socket: net.Socket, host: string, port: number, file: string | null): void {
  logLine(file, `REFUSED ${host}:${port}`)
  const body = `moat's egress policy does not admit ${host}:${port}\n`
  socket.end(
    `HTTP/1.1 403 Forbidden\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  )
}

/**
 * Handle one connection: read the request head, decide, then dial or refuse.
 *
 * CONNECT is tunnelled; an absolute-URI request is forwarded with its request line rewritten to the
 * origin form. Anything else is refused, because a policy that admits a destination it cannot parse
 * is not a policy.
 */
function resolverFor(address: string | null): dns.Resolver | null {
  if (!address) return null
  const resolver = new dns.Resolver()
  resolver.setServers([address])
  return resolver
}

/**
 * Resolve the name here, then dial the address.
 *
 * The proxy is the component that resolves, which is what takes DNS away from the box and off the
 * policy's blind side. With a resolver configured this is a *name* lookup against slirp's resolver;
 * without one it is the process's own resolution, which is what a test or an `open` box gets.
 */
function resolveTarget(host: string, resolver: dns.Resolver | null): Promise<string> {
  if (!resolver || net.isIP(host) !== 0) return Promise.resolve(host)
  return new Promise<string>((resolve, reject) => {
    resolver.resolve4(host, (error, addresses) => {
      if (error) reject(error)
      else if (!addresses || addresses.length === 0) reject(new Error(`no address for ${host}`))
      else resolve(addresses[0]!)
    })
  })
}

function handle(socket: net.Socket, opts: Options, resolver: dns.Resolver | null): void {
  socket.on("error", () => socket.destroy())
  let head = ""
  const onData = (chunk: Buffer): void => {
    head += chunk.toString("latin1")
    const end = head.indexOf("\r\n\r\n")
    if (end === -1) {
      if (head.length > 64 * 1024) socket.destroy()
      return
    }
    socket.off("data", onData)
    const rest = Buffer.concat([Buffer.from(head.slice(end + 4), "latin1")])
    const [requestLine] = head.split("\r\n")
    const parts = (requestLine ?? "").split(" ")
    const method = (parts[0] ?? "").toUpperCase()
    const target = parts[1] ?? ""

    let host: string | undefined
    let port: number
    let forward = ""
    if (method === "CONNECT") {
      const index = target.lastIndexOf(":")
      host = index === -1 ? target : target.slice(0, index)
      port = index === -1 ? 443 : Number(target.slice(index + 1))
    } else {
      try {
        const url = new URL(target)
        host = url.hostname
        port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
        forward = `${method} ${url.pathname}${url.search} ${parts.slice(2).join(" ") || "HTTP/1.1"}`
      } catch {
        socket.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
        return
      }
    }

    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      socket.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
      return
    }
    if (!allowedTarget(opts.allow, host, port)) {
      refuse(socket, host, port, opts.log)
      return
    }

    resolveTarget(host, resolver).then((address) => {
    const upstream = net.connect({ host: address, port })
    upstream.on("error", (error: Error) => {
      // The reason, not just the fact: a dial that fails from here is a fact about the *box's*
      // network — the policy already admitted the name — and without the message it is unguessable.
      logLine(opts.log, `FAILED ${host}:${port} ${error.message}`)
      if (!socket.destroyed) {
        const body = `could not reach ${host}:${port}\n`
        socket.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`)
      }
    })
    upstream.on("connect", () => {
      logLine(opts.log, `ALLOWED ${method} ${host}:${port}`)
      if (method === "CONNECT") {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      } else {
        upstream.write(`${forward}\r\n${head.slice(head.indexOf("\r\n") + 2)}`)
      }
      if (rest.length > 0) upstream.write(rest)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    }, (error: Error) => {
      logLine(opts.log, `FAILED ${host}:${port} ${error.message}`)
      if (!socket.destroyed) {
        const body = `could not resolve ${host}\n`
        socket.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`)
      }
    })
  }
  socket.on("data", onData)
}

/** Is this file the program being run? Importing it must not start a listener. */
function isDirectRun(): boolean {
  const argv1 = process.argv[1]
  return argv1 !== undefined && path.resolve(argv1) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectRun()) {
  const opts = proxyOptions(process.argv.slice(2))
  const resolver = resolverFor(opts.dns)
  const server = net.createServer((socket) => handle(socket, opts, resolver))
  server.on("error", (error) => {
    logLine(opts.log, `LISTEN FAILED ${error.message}`)
    process.exit(1)
  })
  server.listen(opts.port, "127.0.0.1", () => {
    logLine(opts.log, `listening on 127.0.0.1:${opts.port} allowing ${opts.allow.join(" ") || "(nothing)"}`)
  })
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      logLine(opts.log, `stopping on ${signal}`)
      server.close(() => process.exit(0))
      // A tunnel in flight must not hold the process open forever.
      setTimeout(() => process.exit(0), 500).unref()
    })
  }
}
