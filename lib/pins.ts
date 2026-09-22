/**
 * Pinned, verified-against-source constants.
 *
 * Every version here was confirmed against a real artifact, not memory:
 *  - CODEX_VERSION: `npm view @openai/codex version`, and the platform tarball's
 *    sha256 after download.
 *  - ALPINE_VERSION / ALPINE_ROOTFS: `curl -sSI` on the release tarball
 *    returned HTTP 200 with a concrete Content-Length.
 */

/** Target triple we provision inside the rootfs. Alpine is musl, so we take the musl build. */
export const SANDBOX_TRIPLE = "linux-x64-musl"

/**
 * Codex CLI, the agent runtime.
 *
 * 0.155.1 was checked against the real artifact: `npm view @openai/codex version`, and the
 * platform tarball's sha256 after download. The linux platform packages are named
 * `<version>-linux-x64` / `-linux-arm64` and ship **musl** binaries under
 * `vendor/<triple>/bin/codex`, so they run on the Alpine image unmodified — measured, no
 * gcompat, no Node. `docs/HISTORY.md` has the capture.
 */
export const CODEX_VERSION = "0.155.1"

/**
 * Where the agent runtime's binary lands inside the rootfs.
 *
 * There is exactly one runtime. The image cache key carries this path, so adding a binary to
 * the image without invalidating a cached one cannot happen silently — which is the shape of
 * the bug that once handed an environment an image with no runtime in it at all.
 */
export const RUNTIME_BINARY = "/usr/local/bin/codex"

/** npm platform package suffix per sandbox triple. Only what moat actually provisions. */
export const CODEX_PLATFORM_PACKAGE: Record<string, string> = {
  "linux-x64-musl": "linux-x64",
  "linux-arm64-musl": "linux-arm64",
}

/** Target directory inside the tarball per sandbox triple. */
export const CODEX_VENDOR_TRIPLE: Record<string, string> = {
  "linux-x64-musl": "x86_64-unknown-linux-musl",
  "linux-arm64-musl": "aarch64-unknown-linux-musl",
}

/**
 * Published digests, per platform package. A triple with no digest is **refused** rather
 * than downloaded unverified: an unpinned binary that becomes the agent runtime is the one
 * artefact moat cannot be casual about.
 */
export const CODEX_TARBALL_SHA256: Record<string, string> = {
  "linux-x64-musl": "f110cccdd50b0be8130b84f45b3144ea775c233f1c8bd8226da6ee719d63d206",
}

/**
 * Claude Code, the second agent runtime.
 *
 * The same shape as Codex, and for the same reason: the npm package is a *platform* package
 * with `dependencies: {}` that carries a **musl** build, so it runs on the Alpine image with no
 * gcompat and no Node runtime. Measured, not read from a summary: `npm pack
 * @anthropic-ai/claude-code-linux-x64-musl@2.1.278` produced a tarball whose only executable is
 * `package/claude` (228 MB), and running that file inside a moat sandbox printed
 * `2.1.278 (Claude Code)`.
 *
 * Two differences from Codex matter and are not incidental: the platform packages are named
 * `claude-code-<os>-<arch>[-musl]` (no version segment), and the executable sits at the tarball
 * **root** (`package/claude`) rather than under `vendor/<triple>/bin/`.
 */
export const CLAUDE_VERSION = "2.1.278"

/** Where the second runtime's binary lands inside the rootfs. */
export const CLAUDE_BINARY = "/usr/local/bin/claude"

/** npm platform package per sandbox triple. Only what moat actually provisions. */
export const CLAUDE_PLATFORM_PACKAGE: Record<string, string> = {
  "linux-x64-musl": "@anthropic-ai/claude-code-linux-x64-musl",
  "linux-arm64-musl": "@anthropic-ai/claude-code-linux-arm64-musl",
}

/** The executable's path inside the tarball. A constant, because it is not `vendor/…` here. */
export const CLAUDE_TARBALL_PATH = "package/claude"

/**
 * Published digests, per platform. A triple with no digest is **refused** rather than downloaded
 * unverified, exactly as for Codex: an unpinned binary that becomes the agent runtime is the one
 * artefact moat cannot be casual about.
 */
export const CLAUDE_TARBALL_SHA256: Record<string, string> = {
  "linux-x64-musl": "7f11bbabdd47961ad497b29316df2caee1e8df943bc79dff6971328a73de79c9",
}

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
 * The Alpine minirootfs digest, one of the two network artefacts moat verifies by hash.
 *
 * It comes from the release directory's `alpine-minirootfs-3.21.4-x86_64.tar.gz.sha256` file,
 * fetched over TLS and then matched against the tarball moat had already downloaded. The other
 * is the runtime binary, pinned in `CODEX_TARBALL_SHA256` above.
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

/** Where the agent works inside the sandbox rootfs. */
export const SANDBOX_WORKDIR = "/work"
