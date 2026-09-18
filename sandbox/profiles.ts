/**
 * Toolchain profiles.
 *
 * The requirement was "it should be able to move freely, download things, run
 * needed commands, test against real-world environments". Two bad answers to
 * that exist and moat deliberately avoids both:
 *
 *  - Bake a kitchen sink. A 4 GiB image that is slow to build, slow to copy, and
 *    still missing the one thing you needed.
 *  - Bake nothing. The agent spends its first ten turns installing a compiler,
 *    and some installs fail because there are no build tools to build them with.
 *
 * So: a small base image that boots in seconds, plus named profiles that are
 * installed on demand with the sandbox's own package manager, cached per package
 * set, and persisted in the rootfs. `--profile node,python` on any `moat up` adds
 * one; installing is incremental, so adding a profile later costs only the
 * packages that are missing.
 *
 * Every package name below was checked against the real Alpine 3.21 `main` and
 * `community` indexes rather than remembered. (An earlier revision of moat's
 * package list contained a package that does not exist, which is exactly the
 * kind of mistake that only shows up at provisioning time.)
 */

export type Profile = {
  id: string
  label: string
  /** Alpine packages. Resolved against main + community. */
  packages: string[]
  /** Run after packages install, inside the sandbox. */
  post?: string[]
  note: string
}

/** Installed in every image, always. The agent cannot work without these. */
export const BASE_PACKAGES = [
  "bash",
  "git",
  "curl",
  "wget",
  "ripgrep",
  "libstdc++",
  "ca-certificates",
  "coreutils",
  "util-linux",
  "findutils",
  "diffutils",
  "patch",
  "jq",
  "tar",
  "gzip",
  "xz",
  "zstd",
  "unzip",
  "zip",
  "procps",
  // Lets glibc-linked prebuilt binaries run on musl: many CLI tools and language
  // runtimes ship glibc-only builds, and without this they fail with a confusing
  // "not found" that has nothing to do with the file being missing.
  "gcompat",
]

export const PROFILES: Profile[] = [
  {
    id: "node",
    label: "Node.js / TypeScript",
    packages: ["nodejs", "npm", "pnpm", "yarn", "esbuild"],
    post: ["npm config set fund false --global", "npm config set audit false --global"],
    note: "node, npm, pnpm, yarn, esbuild. `bun` is not packaged for Alpine; install it with curl if needed.",
  },
  {
    id: "python",
    label: "Python",
    packages: ["python3", "py3-pip", "py3-virtualenv", "py3-setuptools", "python3-dev", "uv"],
    note: "python3, pip, venv, uv. python3-dev is included so native wheels build.",
  },
  {
    id: "cc",
    label: "C / C++ build toolchain",
    packages: [
      "build-base",
      "gcc",
      "g++",
      "make",
      "cmake",
      "ninja-build",
      "pkgconf",
      "linux-headers",
      "autoconf",
      "automake",
      "libtool",
      "musl-dev",
    ],
    note: "What native npm/pip/cargo dependencies need in order to compile.",
  },
  {
    id: "go",
    label: "Go",
    packages: ["go"],
    note: "Go toolchain and module proxy support.",
  },
  {
    id: "rust",
    label: "Rust",
    packages: ["rust", "cargo"],
    note: "rustc and cargo from Alpine, not rustup.",
  },
  {
    id: "java",
    label: "Java",
    packages: ["openjdk21-jre", "openjdk21"],
    note: "JDK 21.",
  },
  {
    id: "db",
    label: "Databases and clients",
    packages: ["sqlite", "postgresql16", "postgresql16-client", "redis", "mariadb-client"],
    note:
      "Real servers, not just clients: `initdb`/`postgres` and `redis-server` run inside the sandbox, so the agent " +
      "can test against a real database instead of a mock. State lives in the rootfs and persists.",
  },
  {
    id: "net",
    label: "Network and service debugging",
    packages: ["openssh-client-default", "iproute2", "bind-tools", "nmap", "netcat-openbsd", "tcpdump", "socat"],
    note: "ss, dig, nc, socat, tcpdump. Useful when the agent has to debug why something will not connect.",
  },
  {
    id: "browser",
    label: "Headless browser",
    packages: ["chromium", "chromium-chromedriver", "font-noto", "nss", "freetype", "harfbuzz", "ttf-liberation"],
    note:
      "Chromium plus the fonts and libs that make headless screenshots and Playwright/Puppeteer usable. " +
      "Heavy (~600 MB): install it only when the project needs it.",
  },
  {
    id: "cli",
    label: "Quality-of-life CLI",
    packages: ["github-cli", "git-lfs", "tmux", "vim", "nano", "htop", "tree", "yq-go", "less", "bash-completion"],
    note: "gh, git-lfs, tmux, editors, yq. Makes an interactive `moat shell` pleasant.",
  },
]

/** `full` is a deliberate kitchen sink, for people who would rather pay once. */
export const FULL_PROFILE_ID = "full"

export const PROFILE_IDS = [...PROFILES.map((p) => p.id), FULL_PROFILE_ID]

export function findProfile(id: string): Profile | undefined {
  return PROFILES.find((p) => p.id === id)
}

export type ResolvedProfiles = {
  profiles: string[]
  packages: string[]
  post: string[]
  unknown: string[]
}

/**
 * Resolve `--profile` values into one package list.
 *
 * `full` means every profile. Packages are deduplicated and order is preserved
 * so the cache key is stable.
 */
export function resolveProfiles(requested: string[]): ResolvedProfiles {
  const wanted: string[] = []
  const unknown: string[] = []
  for (const raw of requested) {
    for (const id of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (id === FULL_PROFILE_ID) {
        for (const profile of PROFILES) if (!wanted.includes(profile.id)) wanted.push(profile.id)
        continue
      }
      if (!findProfile(id)) {
        unknown.push(id)
        continue
      }
      if (!wanted.includes(id)) wanted.push(id)
    }
  }

  const packages = [...BASE_PACKAGES]
  const post: string[] = []
  for (const id of wanted) {
    const profile = findProfile(id)!
    for (const pkg of profile.packages) if (!packages.includes(pkg)) packages.push(pkg)
    for (const command of profile.post ?? []) if (!post.includes(command)) post.push(command)
  }
  return { profiles: wanted, packages, post, unknown }
}

export function describeProfiles(): string {
  return PROFILES.map((p) => `  ${p.id.padEnd(10)} ${p.label.padEnd(34)} ${p.packages.length} packages`).join("\n")
}
