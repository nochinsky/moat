import assert from "node:assert/strict"
import { test } from "node:test"

import { SLIRP_DNS, SLIRP_NAMESERVER_LINE, slirpArgs } from "../../sandbox/egress.ts"

test("slirp is configured onto the sandbox netns with only the server port forwarded", () => {
  const args = slirpArgs(4242, 51234)
  assert.deepEqual(args, ["--configure", "--mtu=65520", "-p", "127.0.0.1:51234:51234", "4242", "tap0"])
  assert.ok(args.includes("127.0.0.1:51234:51234"))
})

test("the isolated sandbox resolves through slirp, not the host resolver", () => {
  assert.equal(SLIRP_DNS, "10.0.2.3")
  assert.equal(SLIRP_NAMESERVER_LINE, "nameserver 10.0.2.3\n")
})
