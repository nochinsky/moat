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
