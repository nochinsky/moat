import fs from "node:fs"
import path from "node:path"

import { moatHome, type EnvPaths } from "../lib/paths.ts"
import { runInSandbox } from "./launcher.ts"

/**
 * The isolation self-test.
 *
 * Everything here runs INSIDE a real sandbox boot, so the results describe the
 * box the agent actually gets, not a model of it. The tests are the ones a
 * sceptic would run by hand:
 *
 *   - can the box name any path outside itself?            (host project, $HOME)
 *   - can the box read a secret that exists only on the host? (the canary)
 *   - did any host environment variable leak in?
 *   - what exactly is mounted, and is any of it host *data*?
 *   - is PID 1 the sandbox's own init, or something from the host?
 *   - is the network namespace shared? (documented v0 limitation, measured, not hidden)
 */

/**
 * `check`, a property that must hold. A failure fails the run.
 * `note`, measured context that is neither good nor bad (e.g. a deliberate
 *              v0 limitation).
 * `exposure`, a measured weakness that v0 does NOT fix. It must not fail the
 *              run, because it is not a bug; but it must be impossible to miss,
 *              because implying safety a tool does not provide is worse than the
 *              weakness itself. This kind exists because an earlier version of
 *              this file reported "pass" for a sandbox whose bash tool could
 *              read the injected credential.
 */
export type IsolationCheck = { name: string; ok: boolean; detail: string; kind?: "check" | "note" | "exposure" }
export type IsolationReport = {
  checks: IsolationCheck[]
  mounts: string[]
  envNames: string[]
  raw: string
  /** Namespace inode ids observed on the host, for comparison. */
  hostNamespaces: Record<string, string>
}

// The mount namespace symlink is named `mnt` in /proc; `mount` is the name used
// by setns(2) and by the ioctl interface. Verified on this kernel (6.18):
// /proc/self/ns/mount does not exist, /proc/self/ns/mnt does.
const NS_LINKS = ["mnt", "pid", "user", "net", "uts", "ipc"] as const

export function nsId(kind: string): string {
  for (const candidate of kind === "mnt" ? ["mnt", "mount"] : [kind]) {
    try {
      return fs.readlinkSync(`/proc/self/ns/${candidate}`)
    } catch {
      /* try the next spelling */
    }
  }
  return "unknown"
}

export function hostNamespaceIds(): Record<string, string> {
  return Object.fromEntries(NS_LINKS.map((kind) => [kind, nsId(kind)]))
}

/** Host-side canary. It exists only on the host; a sandbox that can read it is broken. */
export function canaryPath(): string {
  return path.join(moatHome(), "canary")
}

export function ensureCanary(): { path: string; value: string } {
  const file = canaryPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const value = `MOAT-CANARY-${Date.now()}-${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 })
  return { path: file, value }
}

/** Environment variables that legitimately exist inside the sandbox. */
export const EXPECTED_SANDBOX_ENV = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "PWD",
  "SHLVL",
  "_",
  "PAGER",
  "PS1",
  "PS2",
  "PS4",
  "OPTIND",
  "IFS",
  "MOAT_SANDBOX",
  "OPENCODE_SERVER_PASSWORD",
  "MOAT_PORT",
  "MOAT_INJECTED_CREDENTIAL",
  "MOAT_PROVIDER_BASE_URL",
  "MOAT_MODEL_ID",
  "MOAT_MODEL",
  "MOAT_CREDENTIAL_EXPIRES_AT",
  "MOAT_CREDENTIAL_TTL_SECONDS",
  "MOAT_CREDENTIAL_FINGERPRINT",
  // The name opencode actually reads. It is present in the real box, so the
  // environment check must be run with it present or it measures a cleaner box
  // than the agent gets.
  "DEEPSEEK_API_KEY",
])

/**
 * The mountinfo fields the doctor renders, as an awk program.
 *
 * Field 4 is the *root*: for a bind mount it is the path on the host filesystem
 * the mount came from, which is the only field that can name host data. Field 5
 * is the mount point (already relative to the sandbox root), field 6 the mount
 * options, and the tail after the separator is the fstype, source and
 * super-options. Exported so a unit test can assert the root field is rendered:
 * without it, a bind of /home/you/project is indistinguishable from a device.
 */
export const MOUNT_FIELDS_AWK = '{split($1,a," "); print a[5]"||"a[4]"||"a[6]"||"$2}'

export type MountAnalysis = {
  /** Mounts whose root field names something outside moat's own state directory. */
  suspicious: string[]
  /** The six host device nodes, which are expected and carry no host data. */
  deviceBinds: string[]
}

export function analyseMounts(mounts: string[], stateRoot: string): MountAnalysis {
  const hostDataPattern = /\/home\/|\/mnt\/|\/media\/|\/usr\/lib\/wsl|^\/init/
  const suspicious = mounts.filter((line) => {
    const [mountPoint = "", root = "", , rest = ""] = line.split("||")
    if (hostDataPattern.test(mountPoint) || hostDataPattern.test(rest)) return true
    if (!root.startsWith("/")) return false
    if (root === "/") return false
    if (/^devtmpfs/.test(rest)) return false
    return root !== stateRoot && !root.startsWith(stateRoot + "/")
  })
  const deviceBinds = mounts.filter((line) => /^\/dev\/(null|zero|full|random|urandom|tty)\|\|\//.test(line))
  return { suspicious, deviceBinds }
}

/**
 * Names that must never appear inside the sandbox, taken from the live host
 * environment so the test adapts to whatever the user happens to have exported.
 */
export function forbiddenHostEnvNames(): string[] {
  const interesting = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SSH|AWS|GPG|KUBE)/i
  return Object.keys(process.env)
    .filter((name) => interesting.test(name))
    .filter((name) => !EXPECTED_SANDBOX_ENV.has(name) && name !== "OPENCODE_SERVER_PASSWORD")
    .sort()
}

function innerScript(opts: {
  hostHome: string
  canary: string
  hostProject: string
  /** Port the host deliberately opened on 127.0.0.1, to measure reachability. */
  hostLoopbackPort: number
}): string {
  return `#!/bin/sh
set -u
echo "MOAT_ID=$(id)"
echo "MOAT_ALPINE=$(cat /etc/alpine-release 2>/dev/null || echo unknown)"
echo "MOAT_PID_COUNT=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l)"
echo "MOAT_PID1=$(cat /proc/1/comm 2>/dev/null || echo unknown)"
for ns in mnt pid user net uts ipc; do
  echo "MOAT_NS_$(echo $ns | tr a-z A-Z)=$(readlink /proc/self/ns/$ns 2>/dev/null || echo unknown)"
done
echo "MOAT_UIDMAP=$(cat /proc/self/uid_map | tr -s ' ')"
if [ -e ${JSON.stringify(opts.hostProject)} ]; then echo "MOAT_HOST_PROJECT=READABLE"; else echo "MOAT_HOST_PROJECT=absent"; fi
if [ -e ${JSON.stringify(opts.hostHome)} ]; then echo "MOAT_HOST_HOME=READABLE"; else echo "MOAT_HOST_HOME=absent"; fi
if cat ${JSON.stringify(opts.canary)} >/dev/null 2>&1; then echo "MOAT_CANARY=READABLE"; else echo "MOAT_CANARY=unreadable"; fi
if [ -e ${JSON.stringify(path.join(opts.hostHome, ".ssh"))} ]; then echo "MOAT_HOST_SSH=READABLE"; else echo "MOAT_HOST_SSH=absent"; fi
if [ -e /root/.ssh ]; then echo "MOAT_ROOT_SSH=present"; else echo "MOAT_ROOT_SSH=absent"; fi
echo "MOAT_ENV_B64=$(env | base64 | tr -d '\\n')"
MOAT_SECRET_ENV_NAMES=""
for name in $(env | cut -d= -f1); do
  case "$name" in
    *KEY*|*TOKEN*|*SECRET*|*PASSWORD*|*CREDENTIAL*) MOAT_SECRET_ENV_NAMES="$MOAT_SECRET_ENV_NAMES$name," ;;
  esac
done
echo "MOAT_SECRET_ENV_NAMES=$MOAT_SECRET_ENV_NAMES"
# The sandbox shares the host's network namespace in v0. These two probes measure
# what that means instead of describing it.
if /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/${opts.hostLoopbackPort}' 2>/dev/null; then
  echo "MOAT_HOST_LOOPBACK=REACHABLE"
else
  echo "MOAT_HOST_LOOPBACK=blocked"
fi
if /bin/bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null; then
  echo "MOAT_EGRESS_OPEN=yes"
else
  echo "MOAT_EGRESS_OPEN=no"
fi
echo "MOAT_MOUNTS_B64=$(awk -F' - ' '${MOUNT_FIELDS_AWK}' /proc/self/mountinfo | base64 | tr -d '\\n')"
`
}

type Parsed = Record<string, string>

/** A host env name we did not expect means real leakage; everything else is accounted for. */
function index0(name: string): boolean {
  return !EXPECTED_SANDBOX_ENV.has(name) && !name.startsWith("MOAT_") && name !== "OPENCODE_SERVER_PASSWORD"
}

type LoopbackProbe = { port: number; close: () => Promise<void> }

async function openLoopbackProbe(): Promise<LoopbackProbe> {
  const net = await import("node:net")
  const server = net.createServer((socket) => socket.end("moat-probe\n"))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

function parseLines(output: string): Parsed {
  const result: Parsed = {}
  for (const line of output.split("\n")) {
    const match = /^(MOAT_[A-Z0-9_]+)=(.*)$/.exec(line)
    if (match) result[match[1]!] = match[2]!
  }
  return result
}

export type BundleExposure = {
  serveEnvNames?: string[]
  secretNamesInServeEnv?: string[]
  redactedInShellEnv?: string[]
  caveat?: string
}

/** Read the exposure record the bundle plugin writes at config time, if a session has run. */
export function readBundleExposure(p: EnvPaths): BundleExposure | null {
  const file = path.join(p.auditDir, "exposure.json")
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as BundleExposure
  } catch {
    return null
  }
}

function decode(value: string | undefined): string {
  if (!value) return ""
  return Buffer.from(value, "base64").toString("utf8")
}

export async function runIsolationChecks(
  p: EnvPaths,
  opts: {
    hostHome: string
    keepCanary?: boolean
    hostNamespaces?: Record<string, string>
    /**
     * Names of the variables moat injects into the agent's boot (values are not
     * needed and are never passed). Supplying the *names* is what makes the
     * environment check measure the environment the agent actually gets, rather
     * than a cleaner one this test invented for itself.
     */
    injectedVarNames?: string[]
  },
): Promise<IsolationReport> {
  const hostNamespaces = opts.hostNamespaces ?? hostNamespaceIds()
  const canary = ensureCanary()

  // A listener the host deliberately opens on loopback. If the sandbox can
  // reach it, the agent can reach every other service you are running locally.
  const probe = await openLoopbackProbe()

  const script = innerScript({
    hostHome: opts.hostHome,
    canary: canary.path,
    hostProject: p.projectDir,
    hostLoopbackPort: probe.port,
  })

  const injected = Object.fromEntries((opts.injectedVarNames ?? []).map((name) => [name, "REDACTED-BY-DOCTOR"]))
  let result: { output: string; code: number }
  try {
    result = await runInSandbox(p, script, { env: injected })
  } finally {
    await probe.close()
  }
  const parsed = parseLines(result.output)

  const envNames = decode(parsed.MOAT_ENV_B64)
    .split("\n")
    .map((line) => line.split("=")[0] ?? "")
    .filter((name) => name.length > 0)
    .sort()

  const mounts = decode(parsed.MOAT_MOUNTS_B64)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .sort()

  const injectedNames = (opts.injectedVarNames ?? []).sort()
  const leaked = envNames.filter(
    (name) => !EXPECTED_SANDBOX_ENV.has(name) && !injectedNames.includes(name) && index0(name),
  )
  const forbidden = forbiddenHostEnvNames()
  const forbiddenPresent = envNames.filter((name) => forbidden.includes(name))

  const { suspicious, deviceBinds } = analyseMounts(mounts, moatHome())

  const checks: IsolationCheck[] = [
    {
      name: "host project not reachable",
      ok: parsed.MOAT_HOST_PROJECT === "absent",
      detail: `${p.projectDir} is ${parsed.MOAT_HOST_PROJECT ?? "?"} inside the sandbox`,
    },
    {
      name: "host home not reachable",
      ok: parsed.MOAT_HOST_HOME === "absent",
      detail: `${opts.hostHome} is ${parsed.MOAT_HOST_HOME ?? "?"} inside the sandbox`,
    },
    {
      name: "host canary unreadable",
      ok: parsed.MOAT_CANARY === "unreadable",
      detail: `${canary.path} (mode 600, exists only on the host) is ${parsed.MOAT_CANARY ?? "?"}`,
    },
    {
      name: "no host ssh directory",
      ok: parsed.MOAT_HOST_SSH === "absent" && parsed.MOAT_ROOT_SSH === "absent",
      detail: `host ${opts.hostHome}/.ssh ${parsed.MOAT_HOST_SSH ?? "?"}; sandbox /root/.ssh ${parsed.MOAT_ROOT_SSH ?? "?"}`,
    },
    {
      name: "no host env forwarded",
      ok: leaked.length === 0 && forbiddenPresent.length === 0,
      detail:
        leaked.length === 0 && forbiddenPresent.length === 0
          ? `no variable from the host environment reached the sandbox; present: ${envNames.join(", ")}` +
            (injectedNames.length > 0 ? ` (plus moat's own ${injectedNames.join(", ")}, which is the credential, disclosed below)` : "")
          : `unexpected: ${[...leaked, ...forbiddenPresent].join(", ")}`,
    },
    {
      name: "no host data mounts",
      ok: suspicious.length === 0,
      detail:
        suspicious.length === 0
          ? `${mounts.length} mounts; none reference a host filesystem path`
          : `suspicious: ${suspicious.join(" | ")}`,
    },
    {
      name: "sandbox pid 1",
      ok:
        (parsed.MOAT_PID1 ?? "") !== "init" &&
        (parsed.MOAT_PID1 ?? "") !== "unknown" &&
        Number(parsed.MOAT_PID_COUNT ?? "0") >= 1 &&
        Number(parsed.MOAT_PID_COUNT ?? "0") <= 12,
      detail: `pid 1 is "${parsed.MOAT_PID1}", ${parsed.MOAT_PID_COUNT} visible processes`,
    },
  ]

  for (const [label, key] of [
    ["mount", "mnt"],
    ["pid", "pid"],
    ["user", "user"],
    ["uts", "uts"],
    ["ipc", "ipc"],
  ] as const) {
    const inside = parsed[`MOAT_NS_${key.toUpperCase()}`] ?? "unknown"
    const outside = hostNamespaces[key] ?? "unknown"
    checks.push({
      name: `own ${label} namespace`,
      ok: inside !== "unknown" && inside !== outside,
      detail: `sandbox ${inside} vs host ${outside}`,
    })
  }
  checks.push({
    name: "uid mapping",
    ok: (parsed.MOAT_UIDMAP ?? "").trim().startsWith("0"),
    detail: `uid_map "${(parsed.MOAT_UIDMAP ?? "").trim()}", uid 0 inside is the calling user outside`,
  })

  // ---------------------------------------------------------------------------
  // Measured exposures. These do NOT fail the run: they are the design you chose
  // (open network, no permission prompts). They are printed because a tool that
  // implies safety it does not provide is worse than the weakness itself.
  // ---------------------------------------------------------------------------
  const secretNames = (parsed.MOAT_SECRET_ENV_NAMES ?? "").split(",").filter((name) => name.length > 0)
  checks.push({
    kind: "exposure",
    name: "credential visible to the agent",
    ok: true,
    detail:
      secretNames.length === 0
        ? "no secret-looking variable reaches tool execution"
        : `${secretNames.join(", ")} are in the environment tool execution inherits. The bundle blanks ` +
          `secret-looking names for shell commands, but the values remain in the opencode process ` +
          `environment and are readable via /proc/<pid>/environ. Use a provider-scoped, spend-capped token.`,
  })
  checks.push({
    kind: "exposure",
    name: "host loopback reachable",
    ok: true,
    detail:
      parsed.MOAT_HOST_LOOPBACK === "REACHABLE"
        ? `the sandbox connected to a service the host opened on 127.0.0.1:${probe.port}. Every service you ` +
          `run locally (databases, dev servers, notebooks) is reachable by the agent.`
        : `the sandbox could not reach 127.0.0.1:${probe.port} on the host`,
  })
  checks.push({
    kind: "exposure",
    name: "egress unrestricted",
    ok: true,
    detail:
      parsed.MOAT_EGRESS_OPEN === "yes"
        ? "the sandbox reached 1.1.1.1:443. The agent can install dependencies AND exfiltrate anything it " +
          "can read, including the project and the injected credential. Egress policy is v2."
        : "no outbound connectivity observed",
  })

  // Deliberate, measured v0 limitation rather than a hidden one: the network
  // namespace is the host's, because rootless port forwarding needs either
  // setuid helpers or a hypervisor, neither of which is available here.
  checks.push({
    kind: "note",
    name: "network namespace shared",
    ok: (parsed.MOAT_NS_NET ?? "") !== "unknown",
    detail:
      (parsed.MOAT_NS_NET ?? "") === hostNamespaces.net
        ? `sandbox and host share ${parsed.MOAT_NS_NET}. The agent has the host's network position. Documented v0 limitation; fixed in v1/v2 (docs/SPEC.md).`
        : `sandbox has its own network namespace (${parsed.MOAT_NS_NET})`,
  })

  // This used to be hardcoded `ok: true` and only pushed when binds were found,
  // so it could not fail and could not report a missing device. The binds are
  // read-write, not read-only: a device node is an interface, not a file, and a
  // read-only bind makes `> /dev/null` fail (verified). They carry no host data.
  checks.push({
    name: "device nodes are the only host mounts",
    ok: deviceBinds.length === 6,
    detail: `${deviceBinds.length}/6 device node bind(s), rw like every rootless runtime: ${deviceBinds.map((m) => m.split("||")[0]).join(", ") || "none found"}`,
  })

  // The bundle runs inside the opencode process, so its own record of the agent
  // environment is authoritative in a way this ephemeral boot cannot be: the
  // ephemeral boot does not load the plugin, so it cannot observe the redaction.
  const bundleExposure = readBundleExposure(p)
  if (bundleExposure) {
    const redacted = bundleExposure.redactedInShellEnv ?? []
    checks.push({
      kind: "exposure",
      name: "shell env redaction (bundle)",
      ok: true,
      detail:
        redacted.length === 0
          ? "the bundle reports no secret-looking variables in the agent environment"
          : `the bundle blanks ${redacted.join(", ")} for shell commands the agent writes. ` +
            `Speed bump only: the values are still in the opencode process environment and reachable ` +
            `via /proc/<pid>/environ. This record comes from the plugin running inside the box.`,
    })
  }

  if (!opts.keepCanary) fs.rmSync(canary.path, { force: true })

  return { checks, mounts, envNames, raw: result.output, hostNamespaces }
}
