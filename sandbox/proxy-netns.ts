import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { PROXY_ADDRESS, PROXY_PORT } from "./proxy.ts"

/**
 * The network namespace the proxy lives in, and the link that reaches it.
 *
 * The proxy cannot be its own policy while it sits inside the box's network namespace: it is a
 * process there, so its outbound traffic passes the box's nftables ruleset — whose accept addresses
 * were resolved at boot. Measured, on the same provider: `ALLOWED` on an `isolated` box (no ruleset)
 * and `FAILED … no response within 10s` on a `filtered` one, because the port it needed was never in
 * the ruleset. And no uid test can fix it, because the proxy is uid 0 inside the box — the same
 * principal as the box's root (docs/EGRESS.md §4, §7).
 *
 * So it gets a namespace of its own, with its own datapath (slirp, attached to this namespace rather
 * than to the box's) and its own policy (itself). The box reaches it across a veth pair, and the box
 * keeps its own datapath and ruleset as the backstop for traffic that ignores the proxy.
 *
 * Measured to be buildable rootless (docs/EGRESS.md §7a): the second namespace is created from inside
 * the box's *user* namespace, so one user namespace owns both, which is what lets a link be moved
 * between them. `ip` is invoked through those namespaces — the host's binary, the box's namespaces —
 * so the image is unchanged, at the cost of iproute2 becoming a host requirement.
 */

/** How a link is made between the box and the proxy: a /30 with one address each. */
export const VETH_BOX_ADDRESS = "10.0.9.1"
export const VETH_BOX_IFACE = "moatp"
export const VETH_PROXY_IFACE = "moatb"
const PREFIX = 30

/** Run through a target's user and network namespaces, the way the proxy itself is placed. */
function inNamespaces(targetPid: number, command: string[]): { code: number; output: string } {
  // Bounded, and that is not decoration: this runs on the host while a boot waits for the link it is
  // building, so an unbounded call that blocks is a boot that hangs rather than a boot that fails —
  // and the failure it produces names the command that blocked. The same rule as the in-box probes,
  // which are wrapped in `timeout` for the same reason.
  const result = spawnSync(
    "nsenter",
    ["--target", String(targetPid), "--user", "--net", "--preserve-credentials", "--", ...command],
    { encoding: "utf8", timeout: 10_000 },
  )
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { code: -1, output: `nsenter ${command.join(" ")} did not return within 10s` }
  }
  return { code: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() }
}

function ipAvailable(): boolean {
  // Bounded too: a hung `ip` here would hang the boot that is waiting for the link.
  return spawnSync("ip", ["-V"], { encoding: "utf8", timeout: 5000 }).status === 0
}

export type ProxyNetnsHandle = {
  /**
   * The process that owns the namespace.
   *
   * Only the pid is returned: the *identity* is the launcher's to read (`processStartTime`), because
   * that is where every other pid in moat is checked before it is signalled — and reading it here
   * would be a second description of the same fact, in a module the launcher already imports.
   */
  holderPid: number
}

/**
 * Create the proxy's namespace, the link, and the addressing, then hand back the handle.
 *
 * The holder is a process that exists only to own the namespace (`unshare --net -- sleep`): a
 * namespace lives as long as it has a member, and this one has to outlive the commands that build it.
 * Reaping the holder tears down the namespace and both ends of the link with it.
 */
export async function startProxyNetns(
  bootPid: number,
  opts: { dir: string; logFile: string; timeoutMs?: number },
): Promise<ProxyNetnsHandle> {
  if (!ipAvailable()) {
    throw new Error(
      "the egress proxy needs a network namespace of its own, and building it needs ip(8) (iproute2) on the host",
    )
  }
  fs.mkdirSync(opts.dir, { recursive: true })
  const pidFile = path.join(opts.dir, "proxy-netns.pid")
  fs.rmSync(pidFile, { force: true })

  // `exec` so the pid written is the holder's own: the shell that writes it *becomes* the holder.
  const holder = spawn(
    "nsenter",
    [
      "--target",
      String(bootPid),
      "--user",
      "--net",
      "--preserve-credentials",
      "--",
      "sh",
      "-c",
      `echo $$ > ${JSON.stringify(pidFile)}; exec unshare --net -- sleep 86400`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  )
  let spawnError: Error | null = null
  holder.on("error", (error) => {
    spawnError = error
  })

  const deadline = Date.now() + (opts.timeoutMs ?? 5000)
  let holderPid = 0
  let boxNetns = ""
  let holderNetns = ""
  try {
    boxNetns = fs.readlinkSync(`/proc/${bootPid}/ns/net`)
  } catch {
    boxNetns = ""
  }
  while (Date.now() < deadline) {
    const text = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : ""
    if (text) {
      const pid = Number(text)
      try {
        holderNetns = fs.readlinkSync(`/proc/${pid}/ns/net`)
        holderPid = pid
        break
      } catch {
        // The pid is written before the namespace exists: keep polling rather than guess.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  const fail = (reason: string): never => {
    try {
      if (holderPid) process.kill(holderPid, "SIGKILL")
      else holder.kill("SIGKILL")
    } catch {
      // Nothing to reap.
    }
    throw new Error(`could not build the proxy's network namespace: ${reason}`)
  }
  if (!holderPid) fail(spawnError ? (spawnError as Error).message : "the namespace holder did not start")
  // The holder has to be a *different* namespace from the box's, or the veth would be built in the
  // box's own and the box would be talking to itself.
  if (holderNetns === boxNetns) fail("the holder shares the box's network namespace")

  const run = (target: number, command: string[]): void => {
    const { code, output } = inNamespaces(target, command)
    if (code !== 0) fail(`${command.join(" ")}: ${output || `exit ${code}`}`)
  }
  // Both ends are created in the box's namespace and one is moved out: creating the pair in the
  // namespace that owns the box's user namespace is what makes the move permitted.
  run(bootPid, ["ip", "link", "add", VETH_BOX_IFACE, "type", "veth", "peer", "name", VETH_PROXY_IFACE])
  run(bootPid, ["ip", "link", "set", VETH_PROXY_IFACE, "netns", String(holderPid)])
  run(bootPid, ["ip", "addr", "add", `${VETH_BOX_ADDRESS}/${PREFIX}`, "dev", VETH_BOX_IFACE])
  run(bootPid, ["ip", "link", "set", VETH_BOX_IFACE, "up"])
  run(holderPid, ["ip", "addr", "add", `${PROXY_ADDRESS}/${PREFIX}`, "dev", VETH_PROXY_IFACE])
  run(holderPid, ["ip", "link", "set", VETH_PROXY_IFACE, "up"])
  // The proxy's way out of its namespace. slirp attaches to the *holder*, not to the box.
  run(holderPid, ["ip", "link", "set", "lo", "up"])

  fs.appendFileSync(
    opts.logFile,
    `${new Date().toISOString()} proxy namespace ${holderNetns} (holder pid ${holderPid}), link ${VETH_BOX_ADDRESS}/${PREFIX} <-> ${PROXY_ADDRESS}, proxy listens on ${PROXY_ADDRESS}:${PROXY_PORT}\n`,
  )
  return { holderPid }
}
