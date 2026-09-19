import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { SLIRP_DNS, SLIRP_NAMESERVER_LINE, addHostForward, runtimeForEgress, slirpArgs } from "../../sandbox/egress.ts"
import { unshareArgs } from "../../sandbox/launcher.ts"

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
  await assert.rejects(() => addHostForward(socketPath, 12345), /refused the port forward/)
})

test("only an isolated sandbox gets its own network namespace", () => {
  assert.ok(unshareArgs("boot.sh", { net: true }).includes("--net"))
  assert.equal(unshareArgs("boot.sh", { net: false }).includes("--net"), false)
  assert.equal(unshareArgs("boot.sh").includes("--net"), false)
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
