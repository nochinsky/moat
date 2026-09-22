import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { PROXY_ADDRESS, PROXY_PORT, allowedTarget, proxyArgs, proxyEnv, proxyModulePath } from "../../sandbox/proxy.ts"

const MODULE = fileURLToPath(new URL("../../sandbox/proxy.ts", import.meta.url))

/**
 * The policy is the only thing standing between the agent and every host it is not allowed to reach,
 * so its edges are pinned rather than assumed: an exact host, an optional port, and no matching by
 * suffix — `evil-api.github.com` must not pass a rule for `api.github.com`, which is the whole
 * reason this component exists.
 */
test("the policy admits an exact host, and only an exact host", () => {
  assert.equal(allowedTarget(["api.deepseek.com"], "api.deepseek.com", 443), true)
  assert.equal(allowedTarget(["api.deepseek.com"], "API.DeepSeek.com", 443), true, "case-insensitive")
  assert.equal(allowedTarget(["api.deepseek.com"], "evil-api.deepseek.com", 443), false, "no suffix match")
  assert.equal(allowedTarget(["api.deepseek.com"], "api.deepseek.com.evil.example", 443), false, "no prefix-of-suffix match")
  assert.equal(allowedTarget(["api.deepseek.com"], "deepseek.com", 443), false, "a parent domain is not the host")
  assert.equal(allowedTarget([], "api.deepseek.com", 443), false, "an empty policy admits nothing")
})

test("a rule may name a port, and then only that port", () => {
  assert.equal(allowedTarget(["registry.example:8443"], "registry.example", 8443), true)
  assert.equal(allowedTarget(["registry.example:8443"], "registry.example", 443), false)
  assert.equal(allowedTarget(["registry.example:8443"], "registry.example", 80), false)
  assert.equal(allowedTarget(["registry.example"], "registry.example", 1234), true, "no port means any port")
})

test("malformed rules are ignored rather than treated as a wildcard", () => {
  assert.equal(allowedTarget([":443"], "anything.example", 443), false)
  assert.equal(allowedTarget(["host:not-a-port"], "host", 443), false)
  assert.equal(allowedTarget([""], "anything.example", 443), false)
})

test("the box is given all three variables, with an empty NO_PROXY", () => {
  // The default address is the far side of the link, not the box's loopback: the proxy is outside the
  // box's network namespace precisely so its own egress is not the box's ruleset.
  const env = proxyEnv({ port: 41417 })
  const url = `http://${PROXY_ADDRESS}:41417`
  assert.equal(env.HTTP_PROXY, url)
  assert.equal(env.HTTPS_PROXY, url)
  assert.equal(env.ALL_PROXY, url)
  // Set and empty on purpose: set so it beats an inherited value, empty so nothing is exempt.
  assert.equal(env.NO_PROXY, "")
  assert.equal(env.no_proxy, "")
})

test("the placement goes through util-linux, in the order that works", () => {
  const args = proxyArgs(4242, ["api.deepseek.com", "registry.example:8443"], "/tmp/proxy.log")
  // `--user` before `--net`, and `--preserve-credentials` present: plain `--net` fails, because
  // nsenter then wants to write gid_map. Measured; docs/EGRESS.md §4.
  assert.deepEqual(args.slice(0, 5), ["--target", "4242", "--user", "--net", "--preserve-credentials"])
  assert.ok(args.includes(process.execPath), "the command is this Node, which the deployment has")
  assert.ok(args.includes(proxyModulePath()), "and this module, in whichever layout is running")
  assert.deepEqual(args.slice(args.indexOf("--allow"), args.indexOf("--allow") + 2), [
    "--allow",
    "api.deepseek.com,registry.example:8443",
  ])
  assert.equal(proxyArgs(1, [], "/tmp/p.log").includes("--allow"), false, "no rules, no flag")
  assert.equal(String(PROXY_PORT), args[args.indexOf("--port") + 1], "the declared port is the one passed")
})

/**
 * The proxy as a program, over real sockets. A tunnel to an admitted destination must carry bytes in
 * both directions, a refused destination must get a 403 that names it, and neither may be reached by
 * accident — the last one matters most, because a proxy that falls back to a direct connection on
 * error is worse than no proxy.
 */
test("the proxy tunnels an admitted destination and refuses the rest", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "moat-proxy-"))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))

  // An upstream that echoes, so a tunnel can be proven to carry bytes both ways.
  const upstream = net.createServer((socket) => socket.on("data", (chunk) => socket.write(chunk)))
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const upstreamPort = (upstream.address() as net.AddressInfo).port
  t.after(() => upstream.close())

  const port = 41417 + 1
  const log = path.join(scratch, "proxy.log")
  // Two arguments: the options overload of `execFile` does not accept `stdio` in this @types/node,
  // and the failure it produces is invisible when the check's output is piped away — which is how a
  // commit here once claimed "typecheck clean" while it was in fact failing. stdout and stderr are
  // pipes by default, and the proxy writes its lines to the log file, so nothing needs reading.
  const child = execFile(process.execPath, [
    MODULE,
    "--port",
    String(port),
    "--bind",
    "127.0.0.1",
    "--log",
    log,
    "--allow",
    `127.0.0.1:${upstreamPort}`,
  ])
  t.after(() => child.kill("SIGKILL"))
  // The listener says when it is up, in its own log, rather than a sleep guessing.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("listening")) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.match(fs.readFileSync(log, "utf8"), /listening on 127\.0\.0\.1:/, "the proxy reported it was listening")

  // Everything the proxy says is accumulated, not just the first chunk: the refusal's body arrives in
  // the same read as its status line, and a `once("data")` here silently threw it away — which is how
  // the assertion below first failed with an empty body.
  const connect = (target: string): Promise<{ status: string; socket: net.Socket; text: () => string }> =>
    new Promise((resolve, reject) => {
      let seen = ""
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`)
      })
      const first = new Promise<string>((res) => {
        socket.on("data", (chunk) => {
          seen += chunk.toString("utf8")
          if (seen.includes("\r\n")) res(seen.split("\r\n")[0]!)
        })
      })
      socket.on("error", reject)
      first.then((status) => resolve({ status, socket, text: () => seen }))
    })

  const admitted = await connect(`127.0.0.1:${upstreamPort}`)
  assert.match(admitted.status, /^HTTP\/1\.1 200 /, "an admitted destination is tunneled")
  const echoed = await new Promise<string>((resolve) => {
    admitted.socket.once("data", (chunk) => resolve(chunk.toString("utf8")))
    admitted.socket.write("hello-through-the-tunnel")
  })
  assert.equal(echoed, "hello-through-the-tunnel", "the tunnel carries bytes in both directions")
  admitted.socket.destroy()

  const refused = await connect("api.deepseek.com:443")
  assert.match(refused.status, /^HTTP\/1\.1 403 /, "a destination outside the policy is refused")
  await new Promise((resolve) => {
    refused.socket.on("end", resolve)
    refused.socket.on("close", resolve)
  })
  assert.match(refused.text(), /api\.deepseek\.com:443/, "and the refusal names what it refused")
  refused.socket.destroy()

  const seen = fs.readFileSync(log, "utf8")
  assert.match(seen, /ALLOWED CONNECT 127\.0\.0\.1:/)
  assert.match(seen, /REFUSED api\.deepseek\.com:443/)
})

/**
 * Importing this module must not start a listener — the same defect that was live in
 * `scripts/trust.mjs`, where a read-only guard rewrote the page it was checking.
 */
test("importing the proxy does not start one", async () => {
  const probe = execFile(process.execPath, [
    "-e",
    `import('${new URL("../../sandbox/proxy.ts", import.meta.url).href}').then((m) => process.stdout.write(String(m.PROXY_PORT)))`,
  ])
  let out = ""
  probe.stdout?.on("data", (chunk) => (out += chunk))
  await new Promise((resolve) => probe.on("exit", resolve))
  assert.equal(out, String(PROXY_PORT), "the import returned, and returned a value rather than a server")
})
