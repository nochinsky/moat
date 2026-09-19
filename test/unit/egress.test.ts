import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  SLIRP_DNS,
  SLIRP_NAMESERVER_LINE,
  addHostForward,
  defaultAllowHosts,
  allowHostProblem,
  parseAllowlist,
  pruneDeadSockets,
  renderNftRules,
  resolveAllowlist,
  runtimeForEgress,
  slirpArgs,
  socketState,
  waitForSocket,
} from "../../sandbox/egress.ts"
import { bootIsolation, unshareArgs } from "../../sandbox/launcher.ts"
import { defaultEgress, isLoopbackHost, ownNetns } from "../../lib/pins.ts"

test("the allowlist parser splits on commas and whitespace without duplicates", () => {
  assert.deepEqual(parseAllowlist("a.example, b.example  c.example,a.example"), ["a.example", "b.example", "c.example"])
  assert.deepEqual(parseAllowlist(undefined), [])
})

test("the default allowlist carries the registries and the provider", () => {
  const hosts = defaultAllowHosts("api.deepseek.com")
  assert.ok(hosts.includes("registry.npmjs.org"))
  assert.ok(hosts.includes("dl-cdn.alpinelinux.org"))
  assert.ok(hosts.includes("api.deepseek.com"))
  assert.equal(new Set(hosts).size, hosts.length, "no duplicates")
})

test("resolution keeps IP literals, expands names, and skips unresolvable hosts", () => {
  return (async () => {
    const ips = await resolveAllowlist(["1.2.3.4", "ok.example", "missing.example"], async (host) => {
      if (host === "ok.example") return ["5.6.7.8", "9.10.11.12"]
      throw new Error("ENOTFOUND")
    })
    assert.deepEqual(ips, ["1.2.3.4", "5.6.7.8", "9.10.11.12"])
  })()
})

test("the ruleset drops by default and allows only DNS and the allowlist", () => {
  const rules = renderNftRules(["5.6.7.8", "9.10.11.12"])
  assert.match(rules, /policy drop;/)
  assert.match(rules, /elements = { 5.6.7.8, 9.10.11.12 }/)
  assert.match(rules, /ip daddr @allowed4 tcp dport { 80, 443 } accept/)
  assert.match(rules, /ip daddr 10.0.2.3 udp dport 53 accept/)
  assert.match(rules, /oif lo accept/)
  assert.match(rules, /ct state established,related accept/)
  // An empty allowlist must still be a valid, maximally strict ruleset.
  const empty = renderNftRules([])
  assert.match(empty, /policy drop;/)
  assert.equal(empty.includes("@allowed4"), false)
  assert.equal(empty.includes("elements"), false)
})

test("slirp closes the host-loopback gateway and takes an API socket", () => {
  const args = slirpArgs(4242, { apiSocket: "/tmp/slirp.sock" })
  assert.deepEqual(args, [
    "--configure",
    "--mtu=65520",
    "--disable-host-loopback",
    "--api-socket",
    "/tmp/slirp.sock",
    "4242",
    "tap0",
  ])
  // Without this flag slirp forwards 10.0.2.2 to the host's loopback, which was
  // measured to answer HTTP 200 from inside the isolated namespace.
  assert.ok(args.includes("--disable-host-loopback"))
})

test("an ephemeral boot takes the datapath without an API socket", () => {
  assert.deepEqual(slirpArgs(4242), ["--configure", "--mtu=65520", "--disable-host-loopback", "4242", "tap0"])
})

test("addHostForward asks slirp for exactly one loopback mapping", async (t) => {
  const socketPath = path.join(os.tmpdir(), "moat-slirp-rpc-" + process.pid + ".sock")
  fs.rmSync(socketPath, { force: true })
  let received = ""
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      received += chunk.toString()
      socket.write('{"return":{"id":1}}\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  t.after(() => {
    server.close()
    fs.rmSync(socketPath, { force: true })
  })
  await addHostForward(socketPath, 12345)
  assert.match(received, /"execute":"add_hostfwd"/)
  assert.match(received, /"host_addr":"127.0.0.1"/)
  assert.match(received, /"host_port":12345/)
  assert.match(received, /"guest_port":12345/)
})

test("an error reply from slirp rejects instead of pretending to forward", async (t) => {
  const socketPath = path.join(os.tmpdir(), "moat-slirp-rpc-err-" + process.pid + ".sock")
  fs.rmSync(socketPath, { force: true })
  const server = net.createServer((socket) => {
    socket.on("data", () => socket.write('{"error":{"code":1,"desc":"port in use"}}\n'))
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  t.after(() => {
    server.close()
    fs.rmSync(socketPath, { force: true })
  })
  const started = Date.now()
  await assert.rejects(() => addHostForward(socketPath, 12345), /refused the port forward/)
  // A refusal is final. Retrying it would turn a clear error into a five-second
  // hang, which is the whole reason the retry loop distinguishes the two.
  assert.ok(Date.now() - started < 1000, "a refusal must not be retried")
})

test("the host forward retries a socket that is not listening yet", async (t) => {
  // Measured on a real boot: connect EAGAIN on slirp's API socket, because its
  // accept queue holds one connection and the readiness probe may still be sitting
  // in it. A connect that never reached slirp is worth another attempt; a late
  // listener is the same shape and is what this test can create deterministically.
  const socketPath = path.join(os.tmpdir(), "moat-slirp-late-" + process.pid + ".sock")
  fs.rmSync(socketPath, { force: true })
  const seen: string[] = []
  const server = net.createServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      seen.push(chunk.toString("utf8"))
      socket.write(JSON.stringify({ error: null }))
    })
  })
  t.after(() => {
    server.close()
    fs.rmSync(socketPath, { force: true })
  })
  const late = setTimeout(() => server.listen(socketPath), 150)
  t.after(() => clearTimeout(late))

  await addHostForward(socketPath, 12345, 3000)
  assert.equal(seen.length, 1)
  assert.match(seen[0]!, /"execute":"add_hostfwd"/)
})

test("a live socket is live and a leftover file is dead", async (t) => {
  // The distinction pruning depends on: only a definitive "nothing is listening"
  // may unlink a socket, because EAGAIN means the accept queue is full, which is
  // what a live socket looks like from here.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moat-sockstate-"))
  const live = path.join(dir, "slirp-1-live.sock")
  const dead = path.join(dir, "slirp-2-dead.sock")
  fs.writeFileSync(dead, "")
  const server = net.createServer(() => {})
  await new Promise<void>((resolve) => server.listen(live, resolve))
  t.after(() => {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  assert.equal(await socketState(live), "live")
  assert.equal(await socketState(dead), "dead")
})

test("a socket file with no listener is not ready", async (t) => {
  // The bug this guards, measured: every boot used the same API socket path, so
  // a restart found the previous slirp's socket file, `existsSync` said "ready",
  // and the port forward failed with ECONNREFUSED (slirp itself could not bind
  // over the corpse). Readiness has to be a connection, not a stat().
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moat-dead-socket-"))
  const dead = path.join(dir, "slirp-1-dead.sock")
  fs.writeFileSync(dead, "")
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.equal(await waitForSocket(dead, 150, { exitCode: null }), false)
})

test("a listening API socket is ready, and only dead ones are reaped", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moat-live-socket-"))
  const live = path.join(dir, "slirp-2-live.sock")
  const dead = path.join(dir, "slirp-3-dead.sock")
  fs.writeFileSync(dead, "")
  const server = net.createServer(() => {})
  await new Promise<void>((resolve) => server.listen(live, resolve))
  t.after(() => {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  assert.equal(await waitForSocket(live, 500, { exitCode: null }), true)
  await pruneDeadSockets(dir)
  assert.equal(fs.existsSync(dead), false)
  assert.equal(fs.existsSync(live), true)
})

test("waiting stops as soon as the process that owns the socket dies", async () => {
  const missing = path.join(os.tmpdir(), "moat-no-such-socket-" + process.pid + ".sock")
  fs.rmSync(missing, { force: true })
  const started = Date.now()
  assert.equal(await waitForSocket(missing, 5000, { exitCode: 1 }), false)
  assert.ok(Date.now() - started < 4000, "a dead process must not be waited out")
})

test("only an isolated sandbox gets its own network namespace", () => {
  assert.ok(unshareArgs("boot.sh", { net: true }).includes("--net"))
  assert.equal(unshareArgs("boot.sh", { net: false }).includes("--net"), false)
  assert.equal(unshareArgs("boot.sh").includes("--net"), false)
})

test("filtered egress is isolated egress plus a ruleset", () => {
  // The bug this guards, measured: `filtered` was not counted as having its own
  // network namespace, so the boot kept the host's netns and nft ran there as an
  // unprivileged user -> "netlink: Error: cache initialization failed". The box
  // would have been unfiltered even if nft had somehow succeeded.
  assert.equal(ownNetns("open"), false)
  assert.equal(ownNetns("isolated"), true)
  assert.equal(ownNetns("filtered"), true)
  const binary = "/usr/local/bin/slirp4netns"
  assert.equal(bootIsolation({ egress: "open" }), false)
  assert.equal(bootIsolation({ egress: "isolated", slirpBinary: binary }), true)
  assert.equal(
    bootIsolation({ egress: "filtered", slirpBinary: binary, egressRules: "/.moat/egress.nft" }),
    true,
  )
})

test("a boot that cannot isolate itself refuses instead of running unfiltered", () => {
  assert.throws(() => bootIsolation({ egress: "isolated" }), /needs the slirp4netns binary/)
  assert.throws(() => bootIsolation({ egress: "filtered" }), /needs the slirp4netns binary/)
  assert.throws(
    () => bootIsolation({ egress: "open", egressRules: "/.moat/egress.nft" }),
    /own network namespace/,
  )
})

test("a new environment defaults to filtered, except for a loopback provider", () => {
  // The default is the product decision: a fresh box gets the allowlist. The one
  // exception is a provider on the host's loopback, which the sandbox's own
  // namespace cannot reach at all, so filtering it would only break the box.
  assert.equal(defaultEgress("https://api.deepseek.com"), "filtered")
  assert.equal(defaultEgress("http://192.168.1.10:8000/v1"), "filtered")
  assert.equal(defaultEgress("http://127.0.0.1:8080/v1"), "open")
  assert.equal(defaultEgress("http://localhost:11434/v1"), "open")
  assert.equal(defaultEgress("http://[::1]:8080/v1"), "open")
  assert.equal(defaultEgress("not a url"), "filtered")
})

test("loopback is the whole 127/8 range, in every spelling", () => {
  // 127.0.0.1 was the only address recognised. A local model server on
  // 127.0.0.2 was then treated as remote, the environment defaulted to
  // "filtered", and the sandbox could not reach the provider at all — the
  // allowlist named an address that means "this box" inside the namespace.
  assert.equal(isLoopbackHost("127.0.0.1"), true)
  assert.equal(isLoopbackHost("127.0.0.2"), true)
  assert.equal(isLoopbackHost("127.255.255.254"), true)
  assert.equal(isLoopbackHost("128.0.0.1"), false)
  assert.equal(isLoopbackHost("0.0.0.0"), true)
  assert.equal(isLoopbackHost("localhost"), true)
  assert.equal(isLoopbackHost("ollama.localhost"), true)
  assert.equal(isLoopbackHost("::1"), true)
  assert.equal(isLoopbackHost("[::1]"), true)
  assert.equal(isLoopbackHost("[::ffff:127.0.0.1]"), true)
  assert.equal(isLoopbackHost("api.deepseek.com"), false)
  assert.equal(isLoopbackHost("10.1.2.3"), false)
  // The URL parser normalises the short forms, so these arrive as 127.0.0.1.
  assert.equal(defaultEgress("http://127.1:11434/v1"), "open")
  assert.equal(defaultEgress("http://0.0.0.0:11434/v1"), "open")
  assert.equal(defaultEgress("http://[::ffff:127.0.0.1]:11434/v1"), "open")
})

test("an allowlist entry that cannot work is refused, not silently dropped", () => {
  // The resolver skips anything that is not a name or an address, so a URL or a
  // host:port looked accepted and the box then could not reach what the user
  // believed they had allowed.
  assert.match(allowHostProblem("https://internal.example")!, /URL/)
  assert.match(allowHostProblem("internal.example:8443")!, /ports 80 and 443/)
  assert.match(allowHostProblem("*.internal.example")!, /wildcards/)
  assert.match(allowHostProblem("10.0.0.0/8")!, /CIDR/)
  assert.match(allowHostProblem("not a host")!, /not a hostname/)
  assert.match(allowHostProblem("[2001:db8::1")!, /bracket/)
  assert.equal(allowHostProblem("registry.npmjs.org"), null)
  assert.equal(allowHostProblem("api.deepseek.com"), null)
  assert.equal(allowHostProblem("10.1.2.3"), null)
  assert.equal(allowHostProblem("2001:db8::1"), null)
  assert.equal(allowHostProblem("[2001:db8::1]"), null)
})

test("open egress needs no datapath binary", () => {
  return (async () => {
    assert.deepEqual(await runtimeForEgress("open"), { egress: "open" })
  })()
})

test("the isolated sandbox resolves through slirp, not the host resolver", () => {
  assert.equal(SLIRP_DNS, "10.0.2.3")
  assert.equal(SLIRP_NAMESERVER_LINE, "nameserver 10.0.2.3\n")
})
