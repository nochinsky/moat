import assert from "node:assert/strict"
import { test } from "node:test"

import {
  SLIRP_DNS,
  SLIRP_NAMESERVER_LINE,
  defaultAllowHosts,
  allowHostProblem,
  parseAllowlist,
  renderNftRules,
  resolveAllowlist,
  resolveAllowlistDetailed,
  runtimeForEgress,
  slirpArgs,
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

test("hosts that resolve to nothing are reported, not just dropped", async () => {
  // Dropping them silently is how a filtered box boots with an allowlist that
  // cannot reach the provider: it looks healthy until the agent calls the model.
  const result = await resolveAllowlistDetailed(
    ["1.2.3.4", "ok.example", "missing.example", "empty.example"],
    async (host) => {
      if (host === "ok.example") return ["5.6.7.8"]
      if (host === "empty.example") return []
      throw new Error("ENOTFOUND")
    },
  )
  assert.deepEqual(result.addresses, ["1.2.3.4", "5.6.7.8"])
  assert.deepEqual(result.unresolved, ["missing.example", "empty.example"])
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

test("slirp closes the host-loopback gateway and is given no API socket", () => {
  // --disable-host-loopback: without it slirp forwards 10.0.2.2 to the host loopback, which
  // was measured answering HTTP 200 from inside the "isolated" namespace. There is no
  // --api-socket either: that socket exists to add host forwards, and the host has nothing in
  // the box to forward to.
  const args = slirpArgs(4242)
  assert.deepEqual(args, ["--configure", "--mtu=65520", "--disable-host-loopback", "4242", "tap0"])
  assert.equal(args.includes("--api-socket"), false)
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
