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

/** Providers moat can infer from a key that is already in the environment. */
export const KEY_PROVIDERS: { envVar: string; provider: string }[] = [
  { envVar: "ZHIPU_API_KEY", provider: "zai" },
  { envVar: "ZAI_API_KEY", provider: "zai" },
  { envVar: "DEEPSEEK_API_KEY", provider: "deepseek" },
  { envVar: "OPENAI_API_KEY", provider: "openai" },
  { envVar: "ANTHROPIC_API_KEY", provider: "anthropic" },
  { envVar: "OPENROUTER_API_KEY", provider: "openrouter" },
  { envVar: "GROQ_API_KEY", provider: "groq" },
  { envVar: "MOONSHOT_API_KEY", provider: "moonshot" },
]

/** Which provider the user has a key for, if exactly one is obvious. */
export function detectProviderFromEnv(): { provider: string; envVar: string } | null {
  for (const candidate of KEY_PROVIDERS) {
    if (process.env[candidate.envVar]) return candidate
  }
  return null
}
