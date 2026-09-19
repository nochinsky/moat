/**
 * Pinned, verified-against-source constants.
 *
 * Every version here was confirmed against a real artifact, not memory:
 *  - OPENCODE_VERSION: `npm view opencode-ai version` -> 1.18.31, and
 *    a local clone of the opencode repository is checked out at that same version
 *    (packages/opencode/package.json "version": "1.18.31").
 *  - ALPINE_VERSION / ALPINE_ROOTFS: `curl -sSI` on the release tarball
 *    returned HTTP 200 with a concrete Content-Length.
 *  - OPENCODE_NPM_PKG: read from `npm view opencode-ai optionalDependencies`.
 */
export const OPENCODE_VERSION = "1.18.31"

/** Target triple we provision inside the rootfs. Alpine is musl, so we take the musl build. */
export const SANDBOX_TRIPLE = "linux-x64-musl"
/** Target triple of the host helper binary (used only for the interactive `opencode attach` TUI). */
export const HOST_TRIPLE = "linux-x64"

export const ALPINE_BRANCH = "v3.21"
export const ALPINE_VERSION = "3.21.4"
export const ALPINE_ROOTFS_URL =
  `https://dl-cdn.alpinelinux.org/alpine/${ALPINE_BRANCH}/releases/x86_64/` +
  `alpine-minirootfs-${ALPINE_VERSION}-x86_64.tar.gz`

/** Packages baked into every rootfs snapshot. Nothing here is a credential. */
export const PROVISION_PACKAGES = [
  "bash",
  "git",
  "curl",
  "ripgrep",
  "libstdc++",
  "ca-certificates",
  "coreutils",
  "util-linux",
  "findutils",
  "diffutils",
  "patch",
  // The egress filter, applied inside the sandbox's own network namespace when
  // egress is filtered. BASE_PACKAGES in sandbox/profiles.ts is the list a normal
  // `moat up` provisions with, and it carries this too; keep them in sync.
  "nftables",
]

export const NPM_REGISTRY = "https://registry.npmjs.org"

/**
 * Published digests for the two network artefacts moat downloads.
 *
 * - the Alpine minirootfs SHA-256 comes from the release directory's
 *   `alpine-minirootfs-3.21.4-x86_64.tar.gz.sha256` file, fetched over TLS and
 *   then matched against the tarball moat had already downloaded;
 * - the opencode tarball's SRI comes from
 *   `npm view opencode-linux-x64-musl@1.18.31 dist.integrity`, same check.
 *
 * A download that does not match is rejected rather than unpacked.
 */
export const ALPINE_ROOTFS_SHA256 = "e5f52d56d807a069ae0acf9015a85c43e057acab1197518171017b68b19bf445"

/**
 * The userspace network datapath for a sandbox with its own network namespace.
 *
 * slirp4netns attaches a tap to the sandbox's namespace and carries packets
 * through a userspace TCP/IP stack, so the box keeps an outbound network while
 * losing the host's network position. It must be static (it runs as the
 * unprivileged user) and pinned (it carries the sandbox's packets), so it is
 * fetched from the release page and checked against the release's SHA256SUMS.
 */
export const SLIRP4NETNS_VERSION = "1.3.5"
export const SLIRP4NETNS_URL =
  `https://github.com/rootless-containers/slirp4netns/releases/download/v${SLIRP4NETNS_VERSION}/slirp4netns-x86_64`
export const SLIRP4NETNS_SHA256 = "8e54132bc80fc60d53af4b544dae63a81151774b56f129e572f7f1a2e89a57cf"

/**
 * How much network the sandbox gets.
 *
 * `open` shares the host's network namespace (the v0 behaviour, and the default
 * until the filtered policy has e2e evidence). `isolated` gives the sandbox its
 * own namespace with slirp4netns as the datapath: it keeps outbound access but
 * loses the host's network position, including the host's loopback.
 */
export type EgressMode = "open" | "isolated" | "filtered"

/**
 * Every mode except `open` runs the sandbox in its own network namespace with
 * slirp4netns as the only datapath; `filtered` adds the nftables allowlist on top
 * of exactly the same namespace. One definition, because treating `filtered` as
 * "open plus rules" is how the rules end up being applied in the host's
 * namespace, where an unprivileged user cannot load them at all.
 */
export function ownNetns(egress: EgressMode): boolean {
  return egress !== "open"
}

/**
 * The policy a *new* environment gets, from where its provider lives.
 *
 * `filtered` is the default: the sandbox keeps outbound access to the provider
 * and the package registries and nothing else. The exception is a provider on
 * the host's own loopback (a local stub, a gateway you run yourself). Slirp's
 * route to the host's loopback is closed on purpose, so such an endpoint is
 * unreachable from the sandbox's namespace by construction; those environments
 * get `open` instead of a box that cannot call the model.
 *
 * An existing environment keeps the mode recorded in its state: this only picks
 * a policy the first time a project is sandboxed.
 */
export function defaultEgress(providerBaseUrl: string): EgressMode {
  let host = ""
  try {
    host = new URL(providerBaseUrl).hostname
  } catch {
    return "filtered"
  }
  return isLoopbackHost(host) ? "open" : "filtered"
}

/**
 * Is this provider address on the host's own loopback?
 *
 * The whole `127.0.0.0/8` range, not just `127.0.0.1` — a local model server on
 * `127.0.0.2` is just as unreachable from the sandbox's namespace, and treating it
 * as remote would silently give the box an allowlist it cannot use. `0.0.0.0` is
 * included because connecting to it on Linux reaches the local host, and the
 * bracketed and IPv4-mapped IPv6 spellings of `::1` are the same address.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1") return true
  // IPv4-mapped IPv6 in either spelling. This matters because the URL parser
  // rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1, so the hex form has to decode.
  const mapped = /^(?:0:0:0:0:0:ffff:|::ffff:)(.+)$/.exec(host)?.[1]
  if (mapped !== undefined) {
    if (mapped.includes(".")) return mapped.startsWith("127.")
    const groups = mapped.split(":")
    const high = groups.length === 2 ? Number.parseInt(groups[0]!, 16) : Number.NaN
    return Number.isFinite(high) && high >> 8 === 127
  }
  if (host === "0.0.0.0") return true
  const parts = host.split(".")
  return parts.length === 4 && parts[0] === "127"
}

/** slirp4netns answers DNS here inside an isolated namespace. */
export const SLIRP_DNS = "10.0.2.3"

/**
 * Hosts a filtered sandbox may reach by default, beyond the provider itself.
 *
 * These are the package sources a coding agent needs to install dependencies:
 * npm, the Alpine CDNs the profile installer rotates between, PyPI, the Go and
 * Rust module proxies, Maven Central and GitHub. The list is deliberately
 * explicit: anything else is dropped, and `--egress-allow` adds to it.
 */
export const EGRESS_REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "dl-cdn.alpinelinux.org",
  "mirror.leaseweb.com",
  "uk.alpinelinux.org",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "storage.googleapis.com",
  "index.crates.io",
  "static.crates.io",
  "repo1.maven.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
]

/** Ports allowed to an allowlisted address. DNS is handled separately. */
export const EGRESS_ALLOWED_PORTS = [80, 443]
export const OPENCODE_TARBALL_INTEGRITY =
  "sha512-TxKfcJII53MZ17NSrJ0p51wx0dJtZrX8By60N5O5/M+eP0oO4jCXKIkdBpP/Bku44gm8QZkTNLBWpPc2OTJweg=="

/**
 * Where the bundle is installed inside the sandbox rootfs.
 * No credentials ever live under here: the provider config references
 * `{env:MOAT_INJECTED_CREDENTIAL}`, which opencode substitutes at load time.
 */
export const BUNDLE_DIR = "/usr/local/share/moat"
export const BUNDLE_CONFIG = `${BUNDLE_DIR}/opencode.json`
export const BUNDLE_PLUGIN = `${BUNDLE_DIR}/plugin/moat-bundle.mjs`
export const SANDBOX_WORKDIR = "/work"
export const AUDIT_LOG = "/var/log/moat/tools.jsonl"

/**
 * The curated tool sets. This is the single source of truth: the renderer builds
 * the config from these, the plugin enforces them, and `moat tools` reports them.
 *
 * `question` is in the core set. opencode gates it on OPENCODE_CLIENT, and moat
 * sets that to `moat`, so the bundle turns it back on with
 * OPENCODE_ENABLE_QUESTION_TOOL=1 and curates it for real. An earlier revision
 * kept it in EXCLUDED_TOOLS while the renderer curated it, which made `moat
 * tools` print a list that contradicted the evidence beside it.
 */
export const CORE_TOOLS = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "glob",
  "grep",
  "bash",
  "todowrite",
  "question",
] as const

/** Everything in core, plus the two tools the opt-in `--tools extended` adds. */
export const EXTENDED_TOOLS = [...CORE_TOOLS, "webfetch", "task"] as const

/** Every built-in opencode 1.18.31 ships (packages/core/src/tool/builtins.ts). */
export const ALL_BUILTINS = [
  "apply_patch",
  "bash",
  "edit",
  "glob",
  "grep",
  "question",
  "read",
  "skill",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
  "task",
] as const

/** The default preset. Kept as a name because almost all of the code means this one. */
export const CURATED_TOOLS = CORE_TOOLS

/**
 * Built-ins that ship with opencode but are deliberately NOT in the bundle.
 *
 * IMPORTANT, and verified against opencode 1.18.31 rather than assumed:
 * opencode has NO supported way to prune a built-in tool from the list it
 * advertises to the model. `tools: {x: false}` compiles to a permission rule
 * (packages/opencode/src/config/config.ts:567), and the model-facing tool list
 * is built from the static `builtin` array in
 * packages/opencode/src/tool/registry.ts (~line 231) with no permission filter
 * (packages/opencode/src/session/tools.ts:92). Only MCP tools are filtered, via
 * Permission.visibleTools at registry.ts:286.
 *
 * One of these is nevertheless absent from the advertised list because opencode
 * itself gates it: `websearch` is gated on the provider (webSearchEnabled,
 * providerID must be opencode/opencode-go or exa/parallel enabled).
 * The other three (`webfetch`, `skill`, `task`) remain advertised. moat
 * therefore enforces the curated set at the tool boundary instead: the bundle
 * plugin refuses any tool id outside CURATED_TOOLS, and records the attempt.
 * See docs/UPSTREAM-CANDIDATES.md for the upstream change that would make this
 * exact.
 */
export const EXCLUDED_TOOLS: string[] = ALL_BUILTINS.filter((name) => !CURATED_TOOLS.includes(name as never))

/**
 * Of the excluded built-ins above, the ones opencode simply cannot stop
 * advertising in v1.18.31. Kept explicit so `moat tools` can report the gap
 * instead of pretending it does not exist.
 */
export const UNADVERTISED_GAPS = ["webfetch", "skill", "task"] as const
