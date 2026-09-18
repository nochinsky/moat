import fs from "node:fs"
import path from "node:path"

/**
 * Work out what a project needs, so the common case needs no flags.
 *
 * The rule is deliberately conservative: only add a profile when the project
 * plainly asks for one. Guessing wrong costs the user a long package install,
 * so a wrong guess is worse than no guess.
 */

const MARKERS: { profile: string; files: string[]; why: string }[] = [
  { profile: "node", files: ["package.json", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"], why: "package.json" },
  {
    profile: "python",
    files: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", "uv.lock"],
    why: "a Python project file",
  },
  { profile: "go", files: ["go.mod"], why: "go.mod" },
  { profile: "rust", files: ["Cargo.toml"], why: "Cargo.toml" },
  { profile: "java", files: ["pom.xml", "build.gradle", "build.gradle.kts"], why: "a JVM build file" },
]

/** Native code that will need a compiler to build. */
const NATIVE_HINTS = [".c", ".cc", ".cpp", ".h", ".hpp", ".rs"]
const NATIVE_MARKERS = ["Makefile", "CMakeLists.txt", "configure.ac", "meson.build"]

export type Detection = {
  profiles: string[]
  reasons: string[]
  /** True when the guess is a guess, e.g. a repo full of C files and no manifest. */
  uncertain: boolean
}

export function detectProfiles(projectDir: string, limit = 4000): Detection {
  const profiles: string[] = []
  const reasons: string[] = []

  for (const marker of MARKERS) {
    if (marker.files.some((file) => fs.existsSync(path.join(projectDir, file)))) {
      profiles.push(marker.profile)
      reasons.push(`${marker.why} -> ${marker.profile}`)
    }
  }

  if (NATIVE_MARKERS.some((file) => fs.existsSync(path.join(projectDir, file)))) {
    profiles.push("cc")
    reasons.push("a native build file -> cc")
  }

  // If there is no manifest at all, look for source files before giving up.
  if (profiles.length === 0) {
    let seen = 0
    let nativeSource = false
    const walk = (dir: string, depth: number): void => {
      if (depth > 3 || seen > limit || nativeSource) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (seen++ > limit) return
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full, depth + 1)
        else if (NATIVE_HINTS.includes(path.extname(entry.name))) nativeSource = true
      }
    }
    walk(projectDir, 0)
    if (nativeSource) {
      profiles.push("cc")
      reasons.push("C/C++/Rust sources and no manifest -> cc")
    }
  }

  // A compiler is needed to build most native addons even when the top-level
  // project is interpreted, but only add it when something already needs it, so
  // the default install stays small.
  return { profiles, reasons, uncertain: reasons.length === 0 }
}

/** Whether the one key moat uses is present on the host. */
export function hasCredentialInEnv(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY || process.env.MOAT_CREDENTIAL)
}

/**
 * The commands the project uses to check itself.
 *
 * moat detects the toolchain already; this is the step further, and it is what
 * makes verification possible: to run the project's tests for the agent, moat has
 * to know what they are. The same list is handed to the agent in its
 * instructions, so it runs your commands instead of inventing its own.
 */
export type Check = { label: string; command: string; kind: "test" | "lint" | "types" }

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

function packageManager(projectDir: string): string {
  const has = (file: string) => fs.existsSync(path.join(projectDir, file))
  if (has("pnpm-lock.yaml")) return "pnpm"
  if (has("yarn.lock")) return "yarn"
  if (has("bun.lockb") || has("bun.lock")) return "bun"
  return "npm"
}

export function detectChecks(projectDir: string): Check[] {
  const checks: Check[] = []
  const has = (file: string) => fs.existsSync(path.join(projectDir, file))

  const pkg = has("package.json") ? readJson(path.join(projectDir, "package.json")) : null
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>
    const pm = packageManager(projectDir)
    // A `test` script that only echoes is worse than no test script.
    for (const [kind, names] of [
      ["test", ["test", "tests"]],
      ["lint", ["lint"]],
      ["types", ["typecheck", "types", "check"]],
    ] as const) {
      const found = names.find((name) => typeof scripts[name] === "string" && scripts[name]!.length > 0)
      if (found) checks.push({ label: `${pm} ${found}`, command: `${pm} run ${found}`, kind })
    }
  }

  if (has("Makefile") || has("makefile")) {
    try {
      const makefile = fs.readFileSync(path.join(projectDir, "Makefile"), "utf8")
      for (const target of ["test", "check"] as const) {
        if (new RegExp(`^${target}:`, "m").test(makefile)) {
          checks.push({ label: `make ${target}`, command: `make ${target}`, kind: target === "test" ? "test" : "lint" })
        }
      }
    } catch {
      /* unreadable Makefile */
    }
  }

  if (has("pyproject.toml") || has("pytest.ini") || has("setup.cfg") || has("requirements.txt")) {
    const looksLikePytest =
      has("pytest.ini") ||
      has("tests") ||
      (has("pyproject.toml") && fs.readFileSync(path.join(projectDir, "pyproject.toml"), "utf8").includes("pytest"))
    if (looksLikePytest) checks.push({ label: "pytest", command: "python3 -m pytest -q", kind: "test" })
    if (has("pyproject.toml") && fs.readFileSync(path.join(projectDir, "pyproject.toml"), "utf8").includes("ruff")) {
      checks.push({ label: "ruff", command: "python3 -m ruff check .", kind: "lint" })
    }
  }

  if (has("Cargo.toml")) checks.push({ label: "cargo test", command: "cargo test --quiet", kind: "test" })
  if (has("go.mod")) checks.push({ label: "go test", command: "go test ./...", kind: "test" })

  // Tests first: that is the one that decides whether the work is any good.
  return checks.sort((a, b) => (a.kind === "test" ? -1 : 0) - (b.kind === "test" ? -1 : 0))
}

/**
 * Refuse to copy a directory that is obviously the wrong one.
 *
 * `moat` on its own is meant to be typed anywhere, which means it will eventually
 * be typed in `$HOME`, in `/`, or in a directory holding fifty gigabytes of
 * video. Copying that into a sandbox is not a mistake anyone recovers from
 * quickly, so it is caught before anything is provisioned.
 */
export type SizeWarning = { reason: string; detail: string } | null

const MAX_FILES = 60_000
const MAX_BYTES = 2 * 1024 * 1024 * 1024

export function checkDirectoryIsSane(projectDir: string): SizeWarning {
  const resolved = path.resolve(projectDir)
  const home = process.env.HOME ? path.resolve(process.env.HOME) : null

  if (resolved === "/") return { reason: "that is the root of the filesystem", detail: resolved }
  if (home && resolved === home) {
    return { reason: "that is your home directory", detail: resolved }
  }
  for (const system of ["/etc", "/usr", "/var", "/bin", "/sbin", "/lib", "/boot", "/proc", "/sys", "/dev"]) {
    if (resolved === system || resolved.startsWith(`${system}/`)) {
      return { reason: `that is inside ${system}, a system directory`, detail: resolved }
    }
  }

  let files = 0
  let bytes = 0
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 12) return false
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue
      const full = path.join(dir, entry.name)
      try {
        const stat = fs.lstatSync(full)
        if (stat.isDirectory()) {
          if (walk(full, depth + 1)) return true
          continue
        }
        files += 1
        bytes += stat.size
        if (files > MAX_FILES || bytes > MAX_BYTES) return true
      } catch {
        /* unreadable entry */
      }
    }
    return false
  }
  if (walk(resolved, 0)) {
    return {
      reason: `it holds more than ${Math.round(MAX_FILES / 1000)}k files or ${MAX_BYTES / 1024 ** 3} GB`,
      detail: `counted at least ${files} files, ${(bytes / 1024 ** 2).toFixed(0)} MiB before stopping`,
    }
  }
  return null
}
