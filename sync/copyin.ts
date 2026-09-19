import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { hashTree } from "../lib/hash.ts"
import type { EnvPaths } from "../lib/paths.ts"
import { ok, run, runRaw } from "../lib/shell.ts"
import { SANITIZED_GIT_ENV, resolveGitDir, sandboxGit } from "../lib/git.ts"
import * as log from "../lib/log.ts"

// Re-exported so the rest of the codebase keeps importing it from here.
export { SANITIZED_GIT_ENV }

/**
 * Copy-in.
 *
 * The project is COPIED into the sandbox. It is never bind-mounted, and the
 * host's `.git` is never copied wholesale, that directory routinely contains
 * remote URLs with embedded tokens, credential helpers and hooks, none of which
 * belong in a box we are about to hand to an autonomous agent.
 *
 * Transport is `git clone --no-hardlinks` (the hardlink flag matters: without
 * it git hardlinks object files, and a hardlink is a real, writable alias into
 * the user's repository). The clone brings history, so the agent can use
 * `git log` / `git blame`, and it sanitises `.git/config` and hooks for free.
 *
 * `git clone` only reproduces *committed* state, so the uncommitted working
 * tree is reproduced on top, using git itself: `git diff --binary HEAD` for
 * tracked modifications and deletions, and `ls-files -o --exclude-standard`
 * for untracked files. Driving it through git (rather than rsync) is what makes
 * deletes, renames, symlinks and binaries come out right.
 *
 * Non-git directories fall back to rsync (as specified) and are then given a
 * fresh repository inside the sandbox so copy-out still works.
 *
 * Known v0 limitation, documented in docs/SPEC.md: gitignored paths
 * (node_modules, .venv, target, ...) are not copied. The box has its own
 * package manager and its own network, and the whole point is a fresh
 * environment.
 */

export type CopyInResult = {
  transport: "git" | "rsync"
  head: string | null
  branch: string | null
  dirty: boolean
  trackedChanges: number
  untrackedFiles: number
  digest: string
  files: number
  bytes: number
  /** Files that look like they hold credentials. Copied anyway, but named loudly. */
  suspectSecrets: string[]
  /**
   * Host paths the copy could not carry. Git cannot represent empty
   * directories or special files, so they are named rather than dropped
   * silently: the sandbox otherwise differs from the host with nothing saying so.
   */
  skippedFromCopy: string[]
  /**
   * Fingerprint of the HOST project at the moment it was copied.
   *
   * Stored so a later `moat up` can tell that the host has moved on. Without it,
   * moat silently runs the agent against a stale copy, which is exactly what
   * happened the first time this was exercised with a real model: the fixture had
   * been rewritten on the host, the sandbox still held the old project, and the
   * agent spent 22 steps hunting for `src/` before giving up.
   */
  hostState: string
}

/**
 * A cheap, precise fingerprint of the host project's *content* as the user sees
 * it: the commit, plus a hash of everything uncommitted. Gitignored files are
 * excluded on purpose, because they are excluded from the copy too, otherwise
 * a `node_modules` directory would report drift on every single boot.
 */
export async function hostState(projectDir: string): Promise<string> {
  if (!(await isGitRepo(projectDir))) {
    return `tree:${hashTree(projectDir).digest}`
  }
  const head = (
    await run("git", ["-C", projectDir, "rev-parse", "HEAD"], { env: SANITIZED_GIT_ENV, allowFailure: true })
  ).stdout.trim()
  const status = (
    await runRaw("git", ["-C", projectDir, "status", "--porcelain", "-z"], { env: SANITIZED_GIT_ENV, allowFailure: true })
  ).stdout

  // The patch goes through a file, never through string capture: a diff of a
  // non-UTF-8 text file is not valid UTF-8, and decoding it to a string and
  // re-encoding corrupts it. Hashing the bytes also keeps the fingerprint
  // independent of git's text escaping. (Binary *files* are base85 in the diff;
  // latin-1 *text* is not.)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "moat-hoststate-"))
  const patch = path.join(scratch, "worktree.patch")
  try {
    await run(
      "git",
      ["-C", projectDir, "diff", "--binary", "--no-ext-diff", `--output=${patch}`, "HEAD"],
      { env: SANITIZED_GIT_ENV, allowFailure: true },
    )
    const bytes = fs.existsSync(patch) ? fs.readFileSync(patch) : Buffer.alloc(0)
    const digest = crypto.createHash("sha256").update(status).update("\0").update(bytes).digest("hex").slice(0, 16)
    return `git:${head}:${digest}`
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Paths that very often hold live credentials. The box holds a full copy of the
 * project and the agent can read all of it and reach the network, so a file like
 * `.npmrc` with a publish token in it is a real exposure. moat does not silently
 * drop these (that would surprise people and break builds); it names them.
 */
const SECRET_FILE = /(^|\/)(\.env(\..+)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials|\.?aws\/credentials|id_rsa[^/]*|id_ed25519[^/]*|id_ecdsa[^/]*|[^/]+\.(pem|key|p12|pfx|jks|keystore))$/i

function scanForSecrets(root: string, limit = 20000): string[] {
  const found: string[] = []
  let seen = 0
  const walk = (dir: string, rel: string): void => {
    if (seen > limit || found.length >= 25) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      seen += 1
      if (seen > limit || found.length >= 25) return
      if (entry.name === ".git") continue
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), entryRel)
      // `.pub` files are public keys, matching them would be noise.
      else if (!entryRel.endsWith(".pub") && SECRET_FILE.test(entryRel)) found.push(entryRel)
    }
  }
  walk(root, "")
  return found.sort()
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return await ok("git", ["-C", dir, "rev-parse", "--git-dir"], { env: SANITIZED_GIT_ENV })
}

export async function copyIn(p: EnvPaths): Promise<CopyInResult> {
  fs.mkdirSync(path.dirname(p.work), { recursive: true })
  if (fs.existsSync(p.work)) fs.rmSync(p.work, { recursive: true, force: true })

  let result: CopyInResult
  if (await isGitRepo(p.projectDir)) {
    const skipped = await cloneGit(p)
    result = await finalize(p, "git", skipped)
  } else {
    log.warn(`${p.projectDir} is not a git repository; falling back to rsync + a fresh in-sandbox repo`)
    await rsyncCopy(p)
    result = await finalize(p, "rsync", [])
  }

  if (result.skippedFromCopy.length > 0) {
    log.warn(
      `${result.skippedFromCopy.length} path(s) cannot be represented in the sandbox: ` +
        `${result.skippedFromCopy.slice(0, 5).join(", ")}${result.skippedFromCopy.length > 5 ? ", …" : ""}\n` +
        "  git does not track empty directories or special files; add a .gitkeep, or run moat in a non-git directory (rsync copies them).",
    )
  }
  return result
}

/** A short word for a filesystem entry, for the skip report. */
function kindOf(stat: fs.Stats): string {
  if (stat.isFIFO()) return "fifo"
  if (stat.isSocket()) return "socket"
  if (stat.isBlockDevice() || stat.isCharacterDevice()) return "device"
  if (stat.isDirectory()) return "directory"
  return "special file"
}

/**
 * Host paths a git project cannot carry across, that a walk can see: empty
 * directories (git does not track directories) and special files (FIFOs,
 * sockets, devices). Ignored paths are excluded, because not copying those is
 * the documented contract rather than a surprise.
 */
async function findUncopiedPaths(projectDir: string): Promise<string[]> {
  const emptyDirs: string[] = []
  const specials: string[] = []
  const seen = { count: 0 }
  const walk = (dir: string, rel: string): void => {
    if (seen.count > 5000 || emptyDirs.length + specials.length >= 25) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.length === 0) {
      if (rel) emptyDirs.push(rel)
      return
    }
    for (const entry of entries) {
      seen.count += 1
      if (seen.count > 5000) return
      if (entry.name === ".git") continue
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name
      const abs = path.join(dir, entry.name)
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(abs)
      } catch {
        continue
      }
      if (stat.isDirectory()) walk(abs, entryRel)
      else if (!stat.isFile() && !stat.isSymbolicLink()) specials.push(entryRel)
    }
  }
  walk(projectDir, "")
  if (emptyDirs.length === 0 && specials.length === 0) return []
  const ignored = await ignoredPaths(projectDir, [...emptyDirs, ...specials])
  return [...emptyDirs, ...specials]
    .filter((name) => !ignored.has(name))
    .map((name) => `${name} (${specials.includes(name) ? "special file" : "empty directory"})`)
}

/** Which of these paths does git ignore? (Those are deliberately not copied.) */
async function ignoredPaths(projectDir: string, paths: string[]): Promise<Set<string>> {
  const result = await run("git", ["-C", projectDir, "check-ignore", "-z", "--stdin"], {
    env: SANITIZED_GIT_ENV,
    allowFailure: true,
    input: `${paths.join("\0")}\0`,
  })
  return new Set(result.stdout.split("\0").filter((name) => name.length > 0))
}

async function cloneGit(p: EnvPaths): Promise<string[]> {
  log.step("copy-in: git clone --no-hardlinks")
  await run("git", ["clone", "--no-hardlinks", "--quiet", p.projectDir, p.work], { env: SANITIZED_GIT_ENV })

  // Reproduce the uncommitted working tree exactly. The patch goes through a
  // file for the same reason the baseline archive does: string capture is lossy
  // for bytes that are not valid UTF-8.
  const patch = path.join(p.dir, "runtime", "worktree.patch")
  fs.mkdirSync(path.dirname(patch), { recursive: true })
  await run("git", ["-C", p.projectDir, "diff", "--binary", "--no-ext-diff", `--output=${patch}`, "HEAD"], {
    env: SANITIZED_GIT_ENV,
    allowFailure: true,
  })
  if (fs.existsSync(patch) && fs.statSync(patch).size > 0) {
    const applied = await sandboxGit(p.work, ["apply", "--whitespace=nowarn", patch], { allowFailure: true })
    if (applied.code !== 0) {
      log.warn(`could not replay uncommitted tracked changes: ${applied.stderr.trim()}`)
    }
  }
  fs.rmSync(patch, { force: true })

  const untracked = await run(
    "git",
    ["-C", p.projectDir, "ls-files", "-o", "--exclude-standard", "-z"],
    { env: SANITIZED_GIT_ENV },
  )
  const names = untracked.stdout.split("\0").filter((name) => name.length > 0)
  const skipped = new Set<string>()
  for (const name of names) {
    const from = path.join(p.projectDir, name)
    const to = path.join(p.work, name)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    const stat = fs.lstatSync(from)
    if (stat.isSymbolicLink()) {
      fs.rmSync(to, { force: true })
      fs.symlinkSync(fs.readlinkSync(from), to)
    } else if (stat.isFile()) {
      fs.copyFileSync(from, to)
      fs.chmodSync(to, stat.mode & 0o777)
    } else {
      skipped.add(`${name} (${kindOf(stat)})`)
    }
  }
  if (names.length > 0) log.debug(`copied ${names.length} untracked file(s)`)
  for (const item of await findUncopiedPaths(p.projectDir)) skipped.add(item)
  return [...skipped].sort()
}

async function rsyncCopy(p: EnvPaths): Promise<void> {
  fs.mkdirSync(p.work, { recursive: true })
  const result = await run(
    "rsync",
    ["-a", "--delete", "--exclude", ".git/", `${p.projectDir}/`, `${p.work}/`],
    { allowFailure: true, env: SANITIZED_GIT_ENV },
  )
  if (result.code !== 0) throw new Error(`rsync copy-in failed: ${result.stderr.trim()}`)
}

async function finalize(p: EnvPaths, transport: "git" | "rsync", skippedFromCopy: string[]): Promise<CopyInResult> {
  const tree = hashTree(p.work)

  let head: string | null = null
  let branch: string | null = null
  let dirty = false
  let trackedChanges = 0
  let untrackedFiles = 0

  if (transport === "git") {
    head = (await sandboxGit(p.work, ["rev-parse", "HEAD"], { allowFailure: true })).stdout.trim() || null
    branch = (await sandboxGit(p.work, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true })).stdout.trim() || null
    const status = await sandboxGit(p.work, ["status", "--porcelain", "-z"], { allowFailure: true })
    const entries = status.stdout.split("\0").filter((line) => line.length > 0)
    dirty = entries.length > 0
    trackedChanges = entries.filter((line) => !line.startsWith("??")).length
    untrackedFiles = entries.filter((line) => line.startsWith("??")).length
  }

  return {
    transport,
    head,
    branch,
    dirty,
    trackedChanges,
    untrackedFiles,
    digest: tree.digest,
    files: tree.files,
    bytes: tree.bytes,
    suspectSecrets: scanForSecrets(p.work),
    skippedFromCopy,
    hostState: await hostState(p.projectDir),
  }
}

/**
 * Record the exact state moat copied, as a commit, without touching the working
 * tree or the index.
 *
 * This is the "base" of the three-way merge that makes applying safe: with it,
 * moat can tell a file the user changed from a file the agent changed, and merge
 * the two instead of overwriting one with the other. Without it, applying is a
 * guess, and a guess that silently eats someone's edit.
 *
 * A temporary index is used so that neither `git add` nor a commit disturbs what
 * the agent will see.
 */
export async function recordBaseline(p: EnvPaths): Promise<string | null> {
  // A pure filesystem check, not a git invocation: if .git is a file or a
  // symlink the hardened runner will refuse, and there is nothing to record.
  if (!resolveGitDir(p.work)) return null
  const indexPath = path.join(p.dir, "runtime", "baseline.index")
  fs.mkdirSync(path.dirname(indexPath), { recursive: true })
  fs.rmSync(indexPath, { force: true })

  const env = {
    ...SANITIZED_GIT_ENV,
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "moat",
    GIT_AUTHOR_EMAIL: "moat@localhost",
    GIT_COMMITTER_NAME: "moat",
    GIT_COMMITTER_EMAIL: "moat@localhost",
  }
  await sandboxGit(p.work, ["read-tree", "HEAD"], { env, allowFailure: true })
  await sandboxGit(p.work, ["add", "-A"], { env })
  const tree = await sandboxGit(p.work, ["write-tree"], { env, allowFailure: true })
  if (tree.code !== 0) return null
  const commit = await sandboxGit(p.work, ["commit-tree", tree.stdout.trim(), "-m", "moat: state copied from the host"], {
    env,
    allowFailure: true,
  })
  fs.rmSync(indexPath, { force: true })
  if (commit.code !== 0) return null
  const sha = commit.stdout.trim()
  await sandboxGit(p.work, ["update-ref", "refs/moat/baseline", sha], { allowFailure: true })
  return sha
}

/**
 * Give a non-git project a repository inside the sandbox, so that every project
 * has one. Runs on the host against files that live in the rootfs; needs no
 * privileges.
 */
export async function ensureSandboxRepo(p: EnvPaths): Promise<void> {
  if (resolveGitDir(p.work)) return
  log.step("copy-in: initialising a repository inside the sandbox (non-git project)")
  // A .git *file* or symlink here is not a repository; remove it before init so
  // git cannot be pointed at a path outside the workspace.
  const dotGit = path.join(p.work, ".git")
  try {
    if (!fs.lstatSync(dotGit).isDirectory()) fs.rmSync(dotGit, { force: true, recursive: true })
  } catch {
    /* nothing there */
  }
  const env = { ...SANITIZED_GIT_ENV, GIT_AUTHOR_NAME: "moat", GIT_AUTHOR_EMAIL: "moat@localhost", GIT_COMMITTER_NAME: "moat", GIT_COMMITTER_EMAIL: "moat@localhost" }
  // init must run before .git exists, so it cannot go through the hardened
  // runner (which refuses anything that is not already a plain .git directory).
  await run("git", ["-C", p.work, "init", "--quiet", "-b", "main"], { env })
  await sandboxGit(p.work, ["add", "-A"], { env })
  // --allow-empty matters: typing `moat` in an empty directory is a use case, and
  // an empty tree cannot be committed without it.
  await sandboxGit(p.work, ["commit", "--quiet", "--allow-empty", "-m", "moat: initial copy-in"], { env })
}
