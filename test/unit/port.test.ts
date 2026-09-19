import assert from "node:assert/strict"
import net from "node:net"
import { test } from "node:test"

import { freePort, hostPortFree } from "../../lib/port.ts"

/** A listener holding a port until it is closed. */
async function hold(port: number, host: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, resolve)
  })
  const address = server.address()
  const bound = typeof address === "object" && address ? address.port : port
  return {
    port: bound,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

test("a port a listener holds is not free, and is again once it closes", async () => {
  // The bug this guards: moat took --port at its word and found out only when the
  // in-box server could not bind — after provisioning, a copy-in, and the whole
  // readiness budget, with a message that named neither the port nor the reason.
  const held = await hold(0, "127.0.0.1")
  try {
    assert.equal(await hostPortFree(held.port), false)
  } finally {
    await held.close()
  }
  assert.equal(await hostPortFree(held.port), true, "released, so free again")
})

test("freePort hands back a port that can actually be bound", async () => {
  const port = await freePort()
  assert.ok(port > 0 && port < 65536)
  assert.equal(await hostPortFree(port), true)
  const held = await hold(port, "127.0.0.1")
  await held.close()
})

test("the check asks about the address the sandbox will bind", async () => {
  // The box binds 0.0.0.0 when it has its own network namespace and 127.0.0.1 when it
  // shares the host's, so an address-blind check would miss the case that matters: a
  // service on another interface blocks a 0.0.0.0 bind and not a loopback one.
  const everywhere = await hold(0, "0.0.0.0")
  try {
    assert.equal(await hostPortFree(everywhere.port, "0.0.0.0"), false)
    assert.equal(await hostPortFree(everywhere.port, "127.0.0.1"), false, "a 0.0.0.0 bind blocks loopback too")
  } finally {
    await everywhere.close()
  }

  const loopbackOnly = await hold(0, "127.0.0.1")
  try {
    assert.equal(await hostPortFree(loopbackOnly.port, "127.0.0.1"), false)
    assert.equal(
      await hostPortFree(loopbackOnly.port, "0.0.0.0"),
      false,
      "a loopback bind blocks a 0.0.0.0 bind, which is the mode the box uses with its own netns",
    )
  } finally {
    await loopbackOnly.close()
  }
})
