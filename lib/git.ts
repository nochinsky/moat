import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { run, runRaw, type RawRunResult, type RunResult } from "./shell.ts"

/**
 * Host-side git, against a repository the sandbox controls.
 *
 * The sandbox's working copy lives at envs/<id>/rootfs/work and its `.git` is
 * fully agent-writable: the agent is root inside the box, and `bash` is one of
 * the curated tools. Git reads repository-local configuration on every command,
 * and several keys execute programs: `core.fsmonitor`, `core.hooksPath`,
 * `filter.*`, `diff.external`, aliases. Running the host's git in that
 * repository without neutralizing its config is host code execution driven by
 * the sandbox. It was verified, not theorised: with `core.fsmonitor` pointed at
 * a script in the worktree, `moat fetch` ran that script on the host.
 *
 * Every host-side git call against the sandbox repository therefore goes through
 * `sandboxGit` below, which:
 *
 *  1. refuses to run if `.git` is not a plain directory inside the workspace
 *     (a `.git` file or symlink can point anywhere, including at host files);
 *  2. swaps in a minimal host-owned config for the duration of the call, keeping
 *     only the repository-format keys needed to read the object store;
 *  3. forces the execution-capable keys off on the command line, in case the
 *     config is recreated while the command runs;
 *  4. restores the agent's own config afterwards, unless the agent changed it in
 *     the meantime.
 *
 * This is defence in depth around a seam that should eventually be removed
 * entirely: the host should read the sandbox's objects through a transport the
 * sandbox cannot configure (see docs/UPSTREAM-CANDIDATES.md).
 */

/** Deterministic git: ignore the user's global/system config for host-side work. */
export const SANITIZED_GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LFS_SKIP_SMUDGE: "1",
  // Read commands must not rewrite the agent's index while the host looks at it.
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
}

const SAFE_CONFIG_HEADER =
  "# written by moat for the duration of a host-side git call; the sandbox's own config is restored afterwards.\n"

let hooksDir: string | null = null

/** An empty, host-owned directory, so `core.hooksPath` can never reach agent files. */
export function emptyHooksDir(): string {
  if (!hooksDir) {
    const uid = typeof process.getuid === "function" ? process.getuid() : "u"
    hooksDir = path.join(os.tmpdir(), `moat-empty-hooks-${uid}`)
    fs.mkdirSync(hooksDir, { recursive: true, mode: 0o700 })
  }
  return hooksDir
}

/**
 * Command-line overrides that beat anything the repository config says. The
 * config swap below is the primary control; these cover the window in which the
 * agent could recreate its config mid-call.
 */
export function hardenedGitArgs(): string[] {
  return [
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${emptyHooksDir()}`,
    "-c",
    "core.pager=cat",
    "-c",
    "core.editor=true",
    "-c",
    "diff.external=",
    "-c",
    "credential.helper=",
    "-c",
    "core.attributesFile=/dev/null",
  ]
}

/** True when `file` exists, is a regular file, and is not a symlink. */
function readRegular(file: string): Buffer | null {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return null
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

/** Write a regular file, unlinking anything (including a symlink) already there. */
function writeRegular(file: string, data: string | Buffer): void {
  try {
    if (!fs.lstatSync(file).isFile()) fs.rmSync(file, { force: true })
  } catch {
    /* does not exist */
  }
  fs.writeFileSync(file, data, { mode: 0o600 })
}

/**
 * The repository's git directory, or null when it is not a plain directory
 * inside `work`. A `.git` file or symlink can name any path on the host, and
 * moat must never write a config through it.
 */
export function resolveGitDir(work: string): string | null {
  const dotGit = path.join(work, ".git")
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(dotGit)
  } catch {
    return null
  }
  if (!stat.isDirectory()) return null
  return dotGit
}

/**
 * Only the keys git needs to interpret the object store. Everything else the
 * agent may have written — fsmonitor, hooks, filters, aliases, includes,
 * remotes, credential helpers — is dropped for the duration of the call.
 *
 * Values are matched strictly and re-emitted from a fixed shape, so a value
 * containing a newline or a section header cannot inject config back in.
 */
export function safeConfigFor(gitDir: string): string {
  const config = path.join(gitDir, "config")
  let text = ""
  try {
    if (fs.lstatSync(config).isFile()) text = fs.readFileSync(config, "utf8")
  } catch {
    /* no config yet */
  }

  let version = "0"
  let objectFormat: string | undefined
  let refStorage: string | undefined
  let section = ""
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim().toLowerCase()
      continue
    }
    const match = /^([A-Za-z0-9.-]+)\s*=\s*([A-Za-z0-9._-]+)$/.exec(line)
    if (!match) continue
    const key = `${section}.${match[1]!.toLowerCase()}`
    if (key === "core.repositoryformatversion") version = match[2]!
    else if (key === "extensions.objectformat") objectFormat = match[2]!
    else if (key === "extensions.refstorage") refStorage = match[2]!
  }

  const lines = [
    SAFE_CONFIG_HEADER.trimEnd(),
    "[core]",
    `\trepositoryformatversion = ${version}`,
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = true",
  ]
  if (objectFormat || refStorage) {
    lines.push("[extensions]")
    if (objectFormat) lines.push(`\tobjectformat = ${objectFormat}`)
    if (refStorage) lines.push(`\trefstorage = ${refStorage}`)
  }
  return `${lines.join("\n")}\n`
}

/** Run `fn` with the repository config replaced by moat's minimal one. */
async function withSafeConfig<T>(work: string, fn: () => Promise<T>): Promise<T> {
  const gitDir = resolveGitDir(work)
  if (!gitDir) {
    throw new Error(
      `moat: refusing to run host git in ${work}: .git is not a plain directory inside the workspace. ` +
        "This is either a linked worktree (unsupported) or a sandbox file pointing somewhere it should not.",
    )
  }
  const config = path.join(gitDir, "config")
  const original = readRegular(config)
  const safe = safeConfigFor(gitDir)
  writeRegular(config, safe)

  // objects/info/alternates is also repository-controlled and names paths the
  // host would read. Park it for the duration so a fetch from the sandbox cannot
  // be pointed at the host's object store.
  const alternatesPath = path.join(gitDir, "objects", "info", "alternates")
  let alternates: { data: Buffer; link: boolean } | null = null
  try {
    const stat = fs.lstatSync(alternatesPath)
    if (stat.isSymbolicLink()) alternates = { data: Buffer.from(fs.readlinkSync(alternatesPath)), link: true }
    else if (stat.isFile()) alternates = { data: fs.readFileSync(alternatesPath), link: false }
    if (alternates) fs.rmSync(alternatesPath, { force: true })
  } catch {
    /* no alternates */
  }

  try {
    return await fn()
  } finally {
    try {
      const current = readRegular(config)
      // Restore only if the file is still ours; the agent may have written a new
      // config while the command ran, and that one is newer than what we saved.
      if (current && current.toString("utf8") === safe) {
        if (original) writeRegular(config, original)
        else fs.rmSync(config, { force: true })
      }
    } catch {
      /* restoring is best effort; the next call re-sanitizes anyway */
    }
    if (alternates) {
      try {
        if (alternates.link) fs.symlinkSync(alternates.data.toString("utf8"), alternatesPath)
        else fs.writeFileSync(alternatesPath, alternates.data)
      } catch {
        /* restoring is best effort */
      }
    }
  }
}

/**
 * Run an arbitrary host-side operation while the sandbox repository's config is
 * neutralized. Needed for git fetch, where the repository being read is the
 * remote side and the command itself runs with -C on the host project.
 */
export async function withSanitizedSandboxRepo<T>(work: string, fn: () => Promise<T>): Promise<T> {
  return withSafeConfig(work, fn)
}

export type SandboxGitOpts = {
  env?: NodeJS.ProcessEnv
  allowFailure?: boolean
  cwd?: string
}

/** Host-side git against the sandbox repository. Strings are fine for its output. */
export async function sandboxGit(work: string, args: string[], opts: SandboxGitOpts = {}): Promise<RunResult> {
  return withSafeConfig(work, () =>
    run("git", [...hardenedGitArgs(), "-C", work, ...args], {
      cwd: opts.cwd,
      allowFailure: opts.allowFailure,
      env: { ...SANITIZED_GIT_ENV, ...opts.env },
    }),
  )
}

/** As `sandboxGit`, for output whose bytes matter (NUL-separated paths). */
export async function sandboxGitRaw(work: string, args: string[], opts: SandboxGitOpts = {}): Promise<RawRunResult> {
  return withSafeConfig(work, () =>
    runRaw("git", [...hardenedGitArgs(), "-C", work, ...args], {
      cwd: opts.cwd,
      allowFailure: opts.allowFailure,
      env: { ...SANITIZED_GIT_ENV, ...opts.env },
    }),
  )
}
