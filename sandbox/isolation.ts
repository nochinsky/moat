import fs from "node:fs"
import path from "node:path"

import { moatHome, type EnvPaths } from "../lib/paths.ts"
import { ownNetns, type EgressMode } from "../lib/pins.ts"
import { shellQuote } from "../lib/shell.ts"
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
  "MOAT_INJECTED_CREDENTIAL",
  "MOAT_PROVIDER_BASE_URL",
  "MOAT_MODEL_ID",
  "MOAT_MODEL",
  "MOAT_CREDENTIAL_EXPIRES_AT",
  "MOAT_CREDENTIAL_TTL_SECONDS",
  "MOAT_CREDENTIAL_FINGERPRINT",
  // The name the native provider's key is injected under, and the name Codex is told to read
  // (env_key in the rendered config). It is present in the real box, so the environment check
  // must be run with it present or it measures a cleaner box than the agent gets.
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
  // A pseudo-filesystem legitimately has "/" as its *root* field: proc, tmpfs and devpts are
  // mounted at a point and their root is the whole of it. A **bind of the host's /** also shows
  // "/", and that is the one mount that would hand the box every host file, so the "/" exemption
  // is by filesystem rather than by root alone.
  const pseudoFilesystem = /^(proc|tmpfs|sysfs|devpts|mqueue|cgroup2?|securityfs|debugfs|tracefs|pstore|bpf|configfs|fusectl|hugetlbfs|binfmt_misc|nsfs|ramfs)\b/
  const suspicious = mounts.filter((line) => {
    const [mountPoint = "", root = "", , rest = ""] = line.split("||")
    if (hostDataPattern.test(mountPoint) || hostDataPattern.test(rest)) return true
    if (!root.startsWith("/")) return false
    if (root === "/" && pseudoFilesystem.test(rest)) return false
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
    .filter((name) => !EXPECTED_SANDBOX_ENV.has(name))
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
# The device nodes are host binds; a failed bind used to leave a regular file behind, so the
# doctor measures what is actually there rather than trusting the boot to have worked.
DEV_MISSING=""
for n in null zero full random urandom tty; do [ -c "/dev/$n" ] || DEV_MISSING="$DEV_MISSING $n"; done
echo "MOAT_DEV_MISSING=$(echo $DEV_MISSING)"
echo "MOAT_PID1=$(cat /proc/1/comm 2>/dev/null || echo unknown)"
for ns in mnt pid user net uts ipc; do
  echo "MOAT_NS_$(echo $ns | tr a-z A-Z)=$(readlink /proc/self/ns/$ns 2>/dev/null || echo unknown)"
done
echo "MOAT_UIDMAP=$(cat /proc/self/uid_map | tr -s ' ')"
if [ -e ${shellQuote(opts.hostProject)} ]; then echo "MOAT_HOST_PROJECT=READABLE"; else echo "MOAT_HOST_PROJECT=absent"; fi
if [ -e ${shellQuote(opts.hostHome)} ]; then echo "MOAT_HOST_HOME=READABLE"; else echo "MOAT_HOST_HOME=absent"; fi
if cat ${shellQuote(opts.canary)} >/dev/null 2>&1; then echo "MOAT_CANARY=READABLE"; else echo "MOAT_CANARY=unreadable"; fi
if [ -e ${shellQuote(path.join(opts.hostHome, ".ssh"))} ]; then echo "MOAT_HOST_SSH=READABLE"; else echo "MOAT_HOST_SSH=absent"; fi
if [ -e /root/.ssh ]; then echo "MOAT_ROOT_SSH=present"; else echo "MOAT_ROOT_SSH=absent"; fi
echo "MOAT_ENV_B64=$(env | base64 | tr -d '\\n')"
MOAT_SECRET_ENV_NAMES=""
for name in $(env | cut -d= -f1); do
  case "$name" in
    *KEY*|*TOKEN*|*SECRET*|*PASSWORD*|*CREDENTIAL*) MOAT_SECRET_ENV_NAMES="$MOAT_SECRET_ENV_NAMES$name," ;;
  esac
done
echo "MOAT_SECRET_ENV_NAMES=$MOAT_SECRET_ENV_NAMES"
# How reachable the host's loopback is, measured two ways. The direct probe is
# the shared-namespace case; 10.0.2.2 is slirp's gateway, which by default
# forwards straight to the host's loopback even from an isolated namespace.
# Only --disable-host-loopback closes that second route, so it is measured.
# Every probe is bounded. A default-deny policy drops rather than refuses, and
# an unbounded connect sits in the kernel's SYN retries for about two minutes
# before it reports the failure it already knows about.
MOAT_PROBE_TIMEOUT=""
if command -v timeout >/dev/null 2>&1; then MOAT_PROBE_TIMEOUT="timeout 6"; fi
if $MOAT_PROBE_TIMEOUT /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/${opts.hostLoopbackPort}' 2>/dev/null; then
  echo "MOAT_HOST_LOOPBACK=REACHABLE"
else
  echo "MOAT_HOST_LOOPBACK=blocked"
fi
if $MOAT_PROBE_TIMEOUT /bin/bash -c 'exec 3<>/dev/tcp/10.0.2.2/${opts.hostLoopbackPort}' 2>/dev/null; then
  echo "MOAT_HOST_LOOPBACK_GATEWAY=REACHABLE"
else
  echo "MOAT_HOST_LOOPBACK_GATEWAY=blocked"
fi
if $MOAT_PROBE_TIMEOUT /bin/bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null; then
  echo "MOAT_EGRESS_OPEN=yes"
else
  echo "MOAT_EGRESS_OPEN=no"
fi
echo "MOAT_MOUNTS_B64=$(awk -F' - ' '${MOUNT_FIELDS_AWK}' /proc/self/mountinfo | base64 | tr -d '\\n')"
`
}

/**
 * What the environment check says about moat's own variables.
 *
 * Only the names that carry the credential are called the credential. The earlier wording
 * called the whole injected list "the credential", which is wrong twice over:
 * MOAT_MODEL and MOAT_PROVIDER_BASE_URL are not secrets, and on a box booted with
 * --no-credential none of the injected names is a credential at all.
 */
export function ownEnvNote(injectedNames: string[]): string {
  if (injectedNames.length === 0) return ""
  const credential = injectedNames.filter((name) => /CREDENTIAL|API_KEY/.test(name))
  return credential.length > 0
    ? ` (plus moat's own ${injectedNames.join(", ")}, of which ${credential.join(", ")} is the credential, disclosed below)`
    : ` (plus moat's own ${injectedNames.join(", ")})`
}

/**
 * What the credential exposure says.
 *
 * When the box was booted with no provider credential, the only secret-looking variable
 * is the sandbox's own server password. The exposure has to say that, instead of asking
 * the user to rotate a key that does not exist.
 */
export function credentialExposureDetail(secretNames: string[], credentialInjected: boolean): string {
  if (secretNames.length === 0) return "no secret-looking variable reaches tool execution"
  if (!credentialInjected) {
    return (
      `secret-looking names in the environment tool execution inherits: ${secretNames.join(", ")}. ` +
      "None of them is a provider credential: this box was booted with no key, so there is nothing " +
      "here to leak. What is present is provider configuration, not a secret."
    )
  }
  return (
    `${secretNames.join(", ")} are in the environment tool execution inherits: the box's process ` +
    `environment, readable via /proc/<pid>/environ. That is how the agent calls the model, so the ` +
    `mitigation is a provider-scoped, spend-capped token rather than hiding the value.`
  )
}

type Parsed = Record<string, string>

/** A host env name we did not expect means real leakage; everything else is accounted for. */
function index0(name: string): boolean {
  return !EXPECTED_SANDBOX_ENV.has(name) && !name.startsWith("MOAT_")
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

function decode(value: string | undefined): string {
  if (!value) return ""
  return Buffer.from(value, "base64").toString("utf8")
}

/**
 * The two-sided filtered-egress check, as a pure function so its claim is testable.
 *
 * The allowlist is the point of this mode, so the check is two-sided *when a probe
 * was supplied*: an arbitrary destination must be refused AND the allowlisted one
 * reachable. The earlier version said "and the provider is reachable" whenever the
 * probe was absent — `allowedOk` was `!allowedProbe || …` — which is a claim about a
 * measurement that never happened. That is the case an environment recorded before
 * base URLs were validated produces, and the doctor must not cover for it: with no
 * probe the detail says the check is one-sided, and the ok value is the half that
 * *was* measured.
 */
export function filteredEgressCheck(opts: {
  egressOpen: boolean
  allowedProbe?: { host: string; port: number }
  allowedReachable: boolean
}): { ok: boolean; detail: string } {
  const refused = "an address outside the allowlist (1.1.1.1:443) is refused"
  if (opts.egressOpen) {
    return { ok: false, detail: "the sandbox reached 1.1.1.1:443, which the allowlist does not contain" }
  }
  if (!opts.allowedProbe) {
    return { ok: true, detail: `${refused}; no allowlisted endpoint was probed, so this check is one-sided` }
  }
  const label = `${opts.allowedProbe.host}:${opts.allowedProbe.port}`
  return opts.allowedReachable
    ? { ok: true, detail: `${refused}, and ${label} is reachable` }
    : { ok: false, detail: `the allowlisted endpoint ${label} was not reachable` }
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
    /** Run the probe in the same kind of network as the environment under test. */
    egress?: EgressMode
    slirpBinary?: string
    egressRules?: string
    /** An endpoint the filtered policy should still allow. */
    allowedProbe?: { host: string; port: number }
  },
): Promise<IsolationReport> {
  const hostNamespaces = opts.hostNamespaces ?? hostNamespaceIds()
  const canary = ensureCanary()

  // A listener the host deliberately opens on loopback. If the sandbox can
  // reach it, the agent can reach every other service you are running locally.
  // A failure here must not leave the canary behind.
  let probe: LoopbackProbe
  try {
    probe = await openLoopbackProbe()
  } catch (error) {
    if (!opts.keepCanary) fs.rmSync(canary.path, { force: true })
    throw error
  }

  const script =
    innerScript({
      hostHome: opts.hostHome,
      canary: canary.path,
      hostProject: p.projectDir,
      hostLoopbackPort: probe.port,
    }) +
    (opts.allowedProbe
      ? "if $MOAT_PROBE_TIMEOUT /bin/bash -c 'exec 3<>/dev/tcp/" +
        shellQuote(opts.allowedProbe.host) +
        "/" +
        opts.allowedProbe.port +
        "' 2>/dev/null; then echo \"MOAT_ALLOWED_REACHABLE=yes\"; else echo \"MOAT_ALLOWED_REACHABLE=no\"; fi\n"
      : "")

  const injected = Object.fromEntries((opts.injectedVarNames ?? []).map((name) => [name, "REDACTED-BY-DOCTOR"]))
  let result: { output: string; code: number }
  try {
    result = await runInSandbox(p, script, {
      env: injected,
      egress: opts.egress,
      slirpBinary: opts.slirpBinary,
      egressRules: opts.egressRules,
    })
  } finally {
    await probe.close()
    // A throwing check must not leave the host canary behind. The success path
    // removes it again below; rm with force is idempotent.
    if (!opts.keepCanary) fs.rmSync(canary.path, { force: true })
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

  // An unset HOME made the two home checks pass vacuously: there is no path to
  // look for, so "absent" proved nothing. Fail them instead.
  const homeKnown = opts.hostHome.startsWith("/")

  const checks: IsolationCheck[] = [
    {
      name: "host project not reachable",
      ok: parsed.MOAT_HOST_PROJECT === "absent",
      detail: `${p.projectDir} is ${parsed.MOAT_HOST_PROJECT ?? "?"} inside the sandbox`,
    },
    {
      name: "host home not reachable",
      ok: homeKnown && parsed.MOAT_HOST_HOME === "absent",
      detail: homeKnown
        ? `${opts.hostHome} is ${parsed.MOAT_HOST_HOME ?? "?"} inside the sandbox`
        : "the host HOME is unset, so this check cannot be performed; failing rather than passing vacuously",
    },
    {
      name: "host canary unreadable",
      ok: parsed.MOAT_CANARY === "unreadable",
      detail: `${canary.path} (mode 600, exists only on the host) is ${parsed.MOAT_CANARY ?? "?"}`,
    },
    {
      name: "no host ssh directory",
      ok: homeKnown && parsed.MOAT_HOST_SSH === "absent" && parsed.MOAT_ROOT_SSH === "absent",
      detail: `host ${opts.hostHome}/.ssh ${parsed.MOAT_HOST_SSH ?? "?"}; sandbox /root/.ssh ${parsed.MOAT_ROOT_SSH ?? "?"}`,
    },
    {
      name: "no host env forwarded",
      ok: leaked.length === 0 && forbiddenPresent.length === 0,
      detail:
        leaked.length === 0 && forbiddenPresent.length === 0
          ? `no variable from the host environment reached the sandbox; present: ${envNames.join(", ")}` +
            ownEnvNote(injectedNames)
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
  // Whether the box this report describes actually has a provider credential, judged by the
  // names the probe was told to inject: a --no-credential box has none, and the exposure
  // must not read as if it did.
  const injectedCredential = injectedNames.some((name) => /CREDENTIAL|API_KEY/.test(name))
  checks.push({
    kind: "exposure",
    name: "credential visible to the agent",
    ok: true,
    detail: credentialExposureDetail(secretNames, injectedCredential),
  })
  // With an isolated namespace this stops being a documented exposure and
  // becomes a property that must hold: the host's loopback must be unreachable.
  const isolated = ownNetns(opts.egress ?? "open")
  const loopbackDirect = parsed.MOAT_HOST_LOOPBACK === "REACHABLE"
  const loopbackGateway = parsed.MOAT_HOST_LOOPBACK_GATEWAY === "REACHABLE"
  const loopbackReachable = loopbackDirect || loopbackGateway
  const loopbackWhere = [loopbackDirect ? "127.0.0.1" : null, loopbackGateway ? "10.0.2.2 (slirp gateway)" : null]
    .filter(Boolean)
    .join(" and ")
  checks.push({
    kind: isolated ? "check" : "exposure",
    name: "host loopback reachable",
    ok: isolated ? !loopbackReachable : true,
    detail: isolated
      ? loopbackReachable
        ? `the sandbox reached the host's loopback through ${loopbackWhere} despite an isolated network namespace`
        : `the sandbox has its own network namespace and reached the host's loopback through neither 127.0.0.1 nor ` +
          `slirp's 10.0.2.2 gateway (port ${probe.port})`
      : loopbackReachable
        ? `the sandbox connected to a service the host opened on 127.0.0.1:${probe.port}. Every service you ` +
          `run locally (databases, dev servers, notebooks) is reachable by the agent.`
        : `the sandbox could not reach 127.0.0.1:${probe.port} on the host`,
  })
  const egressOpen = parsed.MOAT_EGRESS_OPEN === "yes"
  if (opts.egress === "filtered") {
    checks.push({
      kind: "check",
      name: "egress filtered",
      ...filteredEgressCheck({
        egressOpen,
        allowedProbe: opts.allowedProbe,
        allowedReachable: parsed.MOAT_ALLOWED_REACHABLE === "yes",
      }),
    })
  } else {
    checks.push({
      kind: "exposure",
      name: "egress unrestricted",
      ok: true,
      detail:
        parsed.MOAT_EGRESS_OPEN !== "yes"
          ? "no outbound connectivity observed"
          : isolated
            ? "the sandbox reached 1.1.1.1:443 through slirp. It has its own network namespace, but its " +
              "egress is not filtered: use --egress filtered for an allowlist."
            : "the sandbox reached 1.1.1.1:443. It shares the host's network namespace (egress mode " +
              '\"open\"), so the agent can install dependencies AND exfiltrate anything it can read, ' +
              "including the project and the injected credential. A new environment defaults to \"filtered\".",
    })
  }

  // In open mode the shared namespace is a documented limitation (a note). In
  // isolated mode it is a property that must hold.
  const netIsolated = (parsed.MOAT_NS_NET ?? "") !== "unknown" && (parsed.MOAT_NS_NET ?? "") !== hostNamespaces.net
  checks.push({
    kind: isolated ? "check" : "note",
    name: isolated ? "network namespace isolated" : "network namespace shared",
    ok: isolated ? netIsolated : (parsed.MOAT_NS_NET ?? "") !== "unknown",
    detail: netIsolated
      ? `sandbox net:${parsed.MOAT_NS_NET} differs from host net:${hostNamespaces.net}; slirp4netns carries its traffic`
      : `sandbox and host share ${parsed.MOAT_NS_NET}. The agent has the host's network position (egress mode open).`,
  })

  // This used to be hardcoded `ok: true` and only pushed when binds were found,
  // so it could not fail and could not report a missing device. The binds are
  // read-write, not read-only: a device node is an interface, not a file, and a
  // read-only bind makes `> /dev/null` fail (verified). They carry no host data.
  // A bind that is not a device inside the box: writes to it land in the rootfs, reads of
  // /dev/urandom return nothing, and nothing else would say so.
  const devMissing = (parsed.MOAT_DEV_MISSING ?? "?").trim()
  checks.push({
    name: "device nodes are real devices",
    ok: devMissing === "",
    detail:
      devMissing === ""
        ? "all six device nodes are character devices inside the box"
        : devMissing === "?"
          ? "the probe did not report the device nodes at all"
          : `not a character device inside the box:${devMissing}`,
  })
  checks.push({
    name: "device nodes are the only host mounts",
    ok: deviceBinds.length === 6,
    detail: `${deviceBinds.length}/6 device node bind(s), rw like every rootless runtime: ${deviceBinds.map((m) => m.split("||")[0]).join(", ") || "none found"}`,
  })

  if (!opts.keepCanary) fs.rmSync(canary.path, { force: true })

  return { checks, mounts, envNames, raw: result.output, hostNamespaces }
}
