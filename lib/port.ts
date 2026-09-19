import net from "node:net"

/**
 * Ports, and whether the host can actually use one.
 *
 * Both of these exist because a port that is not free is a boot that cannot start,
 * and the two callers want different halves of that fact: picking one that is
 * (freePort) and checking the one the user named (hostPortFree).
 */

/**
 * A port the host can bind right now.
 *
 * Binding 0 and closing again is the standard way to ask the kernel for one. The
 * window between this and the sandbox's own bind is a few seconds (slirp and the
 * spawn), which is why the *named* port is checked up front instead: a race there
 * is rare, but a port the user picked is not a race at all.
 */
export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * Can the host bind \`port\` here, right now?
 *
 * \`host\` is the address the sandbox's server will bind: 0.0.0.0 when the box has
 * its own network namespace, 127.0.0.1 when it shares the host's. Asking about the
 * same address is what makes the answer mean something — a service on another
 * interface blocks a 0.0.0.0 bind and not a loopback one.
 */
export async function hostPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen(port, host, () => server.close(() => resolve(true)))
  })
}
