import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { partPath, type EnvPaths } from "../lib/paths.ts"
import { run } from "../lib/shell.ts"
import { SANITIZED_GIT_ENV, sandboxGit, sandboxGitRaw } from "../lib/git.ts"
import {
  knownCredentialValues,
  leakingFiles,
  noteFilesTooLargeToScan,
  noteScanSkipped,
  warnAboutCredentialLeak,
} from "./leak-scan.ts"

/**
 * Bring the agent's work into the user's directory.
 *
 * The whole difficulty here is that two people edited the same tree: the user on
 * the host, and the agent in the sandbox. A copy that simply overwrites is how
 * someone loses an afternoon's work, so this is a three-way merge against the
 * state moat copied:
 *
 *   base   what moat copied in          (refs/moat/baseline)
 *   theirs what the agent has now       (the sandbox working tree)
 *   mine   what the user has now        (the host directory)
 *
 * Per file:
 *   - only the agent changed it           -> take the agent's version
 *   - both changed it, merges cleanly     -> take the merge
 *   - both changed it, and it conflicts   -> leave the user's file alone, report it
 *   - only the user changed it            -> nothing to do
 *
 * Nothing is written until the whole plan is computed, and a conflict never
 * results in a written file. "I could not merge this one" is always better than
 * a silent overwrite.
 *
 * Three rules that are easy to get wrong, and that this file tests for:
 *
 *  - If the user deleted a file the agent changed, that is a conflict, not an
 *    'add'. Resurrecting a file someone deliberately removed is data loss too.
 *  - A path is not a name. Git output is parsed NUL-separated, because splitting
 *    on whitespace collapses 'a  b' into 'a b' and writes to the wrong file.
 *  - Every change is re-checked against the state it was planned from, so an
 *    edit made while the user was reading the plan is never overwritten.
 */

export type ChangeKind = "add" | "modify" | "delete" | "merge" | "mode" | "link"

export type PlannedChange = {
  path: string
  kind: ChangeKind
  /** True when moat will not touch this file. */
  conflict: boolean
  note?: string
  /** State of the host path when the plan was made; re-checked before writing. */
  expectedHost: string
  /** kind === 'merge': the host-side file holding the merged bytes. */
  mergedFile?: string
  /** kind === 'link': the symlink target to create. */
  linkTarget?: string
  /** File mode to set after writing (kind === 'mode' sets it on its own). */
  mode?: number
}

export type ApplyPlan = {
  changes: PlannedChange[]
  conflicts: PlannedChange[]
  /** Files the agent produced that would become new files on the host. */
  added: number
  /** True when there is nothing to do at all. */
  empty: boolean
  /** Set when the baseline cannot be read: applying is impossible, not empty. */
  baselineProblem: string | null
  /** Commit refs/moat/baseline pointed at when the plan was made. */
  baselineCommit: string | null
  /**
   * Files this plan would write whose content contains the credential moat
   * injected into the sandbox. Populated by the scan in `planApply`; empty when
   * the host has no credential value to compare against.
   */
  credentialLeaks: string[]
}

type Entry =
  | { kind: "missing" }
  | { kind: "file"; hash: string; mode: number }
  | { kind: "link"; hash: string }
  | { kind: "dir" }
  | { kind: "other" }

function sha(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function digestFile(file: string): string {
  return sha(fs.readFileSync(file))
}

/** Content identity of one path, without following symlinks. */
function entryState(abs: string): Entry {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(abs)
  } catch {
    return { kind: "missing" }
  }
  if (stat.isSymbolicLink()) {
    let target = ""
    try {
      target = fs.readlinkSync(abs)
    } catch {
      /* unreadable link: treat as an empty target */
    }
    return { kind: "link", hash: sha(target) }
  }
  if (stat.isDirectory()) return { kind: "dir" }
  if (!stat.isFile()) return { kind: "other" }
  return { kind: "file", hash: digestFile(abs), mode: stat.mode & 0o777 }
}

/** A stable string for 'what this path was', used to detect changes after planning. */
function entryKey(entry: Entry): string {
  if (entry.kind === "file") return "file:" + entry.hash + ":" + entry.mode
  if (entry.kind === "link") return "link:" + entry.hash
  return entry.kind
}

function sameContent(a: Entry, b: Entry): boolean {
  if (a.kind === "missing" || b.kind === "missing") return a.kind === b.kind
  if (a.kind === "dir" || b.kind === "dir") return a.kind === b.kind
  if (a.kind === "other" || b.kind === "other") return a.kind === b.kind
  return a.hash === b.hash
}

/** How long a plan's merge temps may live before they are treated as abandoned. */
const MERGE_TEMP_TTL_MS = 60 * 60 * 1000

/**
 * Reap merge temps nobody can still be using.
 *
 * This used to delete every `moat-merge-*`/`moat-theirs-*` file it found, and the
 * names were derived from the path alone, so a plan running while another apply was
 * in flight had its merged inputs deleted under it: `applyPlan` then skipped the
 * change, silently, and two concurrent plans wrote one temp file. Names are unique
 * per call now (`partPath`), and only files older than an hour are reaped — a live
 * invocation's inputs are younger than that by definition, and a crashed one's are
 * eventually cleaned up instead of growing forever.
 */
function cleanupMergeTemps(p: EnvPaths): void {
  const dir = path.join(p.dir, "runtime")
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - MERGE_TEMP_TTL_MS
  for (const name of names) {
    if (!name.startsWith("moat-merge-") && !name.startsWith("moat-theirs-") && name !== "merged.tmp") continue
    const full = path.join(dir, name)
    let mtime = 0
    try {
      mtime = fs.statSync(full).mtimeMs
    } catch {
      continue
    }
    if (mtime > cutoff) continue
    fs.rmSync(full, { force: true })
  }
}

/**
 * Materialise the baseline tree so the host can be compared against it.
 *
 * The archive goes through a *file*, never through this process: a tar archive
 * is binary, and the string-capturing runner is lossy for binary data. The
 * resolved commit is returned as well, so callers can notice that the ref moved
 * or disappeared underneath them.
 */
async function materialiseBaseline(p: EnvPaths): Promise<{ dir: string | null; commit: string | null; problem: string | null }> {
  const rev = await sandboxGit(p.work, ["rev-parse", "--verify", "--quiet", "refs/moat/baseline"], { allowFailure: true })
  const commit = rev.code === 0 ? rev.stdout.trim() : ""
  if (!commit) {
    return {
      dir: null,
      commit: null,
      problem:
        "the sandbox no longer has refs/moat/baseline, the commit that records what moat copied in. " +
        "Without it there is no third input to merge against, and applying could overwrite your work. " +
        "Run 'moat up --sync' to re-copy the project, or fetch the branch and merge it by hand.",
    }
  }

  const dir = path.join(p.dir, "baseline")
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const archive = path.join(p.dir, "baseline.tar")
  try {
    const tarred = await sandboxGit(p.work, ["archive", "--format=tar", "--output=" + archive, commit], {
      allowFailure: true,
    })
    if (tarred.code !== 0) {
      return { dir: null, commit, problem: "could not archive " + commit.slice(0, 12) + " from the sandbox repository" }
    }
    const extract = await run("tar", ["-xf", archive, "-C", dir], { env: SANITIZED_GIT_ENV, allowFailure: true })
    if (extract.code !== 0) return { dir: null, commit, problem: "could not unpack the recorded baseline" }
    return { dir, commit, problem: null }
  } finally {
    fs.rmSync(archive, { force: true })
  }
}

type AgentChange = { path: string; status: string }

/**
 * Every path the agent has touched, relative to the baseline.
 *
 * The -z flag is load-bearing. Without it git separates fields with a tab and
 * escapes unusual bytes, and splitting the result on whitespace turns 'a  b'
 * into 'a b' - a name that then refers to a different file on the host.
 */
async function agentChanges(p: EnvPaths): Promise<{ changes: AgentChange[]; unrepresentable: string[] }> {
  const diff = await sandboxGitRaw(
    p.work,
    ["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", "refs/moat/baseline"],
    { allowFailure: true },
  )
  const parts = splitNul(diff.stdout)
  const changes: AgentChange[] = []
  const unrepresentable: string[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!.toString("utf8")
    const name = decodePath(parts[i + 1]!)
    if (name === null) unrepresentable.push(parts[i + 1]!.toString("utf8"))
    else changes.push({ status, path: name })
  }

  const untracked = await sandboxGitRaw(p.work, ["ls-files", "-o", "--exclude-standard", "-z"], { allowFailure: true })
  for (const raw of splitNul(untracked.stdout)) {
    if (raw.length === 0) continue
    const name = decodePath(raw)
    if (name === null) unrepresentable.push(raw.toString("utf8"))
    else changes.push({ status: "A", path: name })
  }

  // A file can appear in both lists if it was committed and then touched again.
  const merged = new Map<string, string>()
  for (const entry of changes) merged.set(entry.path, entry.status)
  return { changes: [...merged].map(([file, status]) => ({ path: file, status })), unrepresentable }
}

/** Split a NUL-separated git stream into its records. */
function splitNul(buffer: Buffer): Buffer[] {
  const out: Buffer[] = []
  let start = 0
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) {
      out.push(buffer.subarray(start, i))
      start = i + 1
    }
  }
  if (start < buffer.length) out.push(buffer.subarray(start))
  return out
}

/**
 * A path git reported, or null when its bytes are not valid UTF-8.
 *
 * The host cannot honestly name such a file (Node paths are strings), so moat
 * refuses to act on it instead of guessing and touching the wrong path.
 */
function decodePath(raw: Buffer): string | null {
  const text = raw.toString("utf8")
  return Buffer.from(text, "utf8").equals(raw) ? text : null
}

/** Try a real three-way merge, byte for byte, into a per-path temp file. */
async function attemptMerge(
  p: EnvPaths,
  changePath: string,
  hostFile: string,
  baseFile: string,
  sandboxFile: string,
  mode: number,
): Promise<PlannedChange> {
  const dir = path.join(p.dir, "runtime")
  fs.mkdirSync(dir, { recursive: true })
  const key = sha(changePath).slice(0, 16)
  // Unique per call, not per path: two applies of one environment can be in flight
  // (a second terminal, a script), and they must not share a merge target.
  const mine = partPath(path.join(dir, "moat-merge-" + key))
  const theirs = partPath(path.join(dir, "moat-theirs-" + key))
  fs.copyFileSync(hostFile, mine)
  fs.copyFileSync(sandboxFile, theirs)
  const merged = await run("git", ["merge-file", mine, baseFile, theirs], {
    env: SANITIZED_GIT_ENV,
    cwd: p.dir,
    allowFailure: true,
  })
  fs.rmSync(theirs, { force: true })
  if (merged.code === 0) {
    return {
      path: changePath,
      kind: "merge",
      conflict: false,
      note: "both changed it; merged",
      expectedHost: entryKey(entryState(hostFile)),
      mergedFile: mine,
      mode,
    }
  }
  fs.rmSync(mine, { force: true })
  return {
    path: changePath,
    kind: "merge",
    conflict: true,
    note: "you and the agent both changed it, and the changes overlap",
    expectedHost: entryKey(entryState(hostFile)),
  }
}

function plannedFor(
  sand: Entry,
  hostKey: string,
  changePath: string,
  sandboxFile: string,
  kind: "add" | "modify",
): PlannedChange {
  if (sand.kind === "link") {
    return { path: changePath, kind: "link", conflict: false, expectedHost: hostKey, linkTarget: readLink(sandboxFile) }
  }
  if (sand.kind === "file") {
    return { path: changePath, kind, conflict: false, expectedHost: hostKey, mode: sand.mode }
  }
  return { path: changePath, kind, conflict: false, expectedHost: hostKey }
}

/**
 * Work out what applying would do, without doing any of it.
 *
 * Written so the caller can show the user first. 'moat apply' prints this, and
 * the interactive session shows it before asking.
 */
export async function planApply(p: EnvPaths): Promise<ApplyPlan> {
  cleanupMergeTemps(p)
  const baseline = await materialiseBaseline(p)
  const changes: PlannedChange[] = []
  const empty: ApplyPlan = {
    changes,
    conflicts: [],
    added: 0,
    empty: true,
    baselineProblem: baseline.problem,
    baselineCommit: baseline.commit,
    credentialLeaks: [],
  }
  if (baseline.problem) return empty

  const baselineDir = baseline.dir!
  const { changes: agent, unrepresentable } = await agentChanges(p)
  for (const name of unrepresentable) {
    changes.push({
      path: name,
      kind: "modify",
      conflict: true,
      note: "the filename is not valid UTF-8, so moat cannot name it on the host",
      expectedHost: "missing",
    })
  }

  for (const entry of agent) {
    const sandboxFile = path.join(p.work, entry.path)
    const hostFile = path.join(p.projectDir, entry.path)
    const baseFile = path.join(baselineDir, entry.path)

    const base = entryState(baseFile)
    const host = entryState(hostFile)
    const sand = entryState(sandboxFile)
    const hostKey = entryKey(host)

    if (entry.status === "D" || sand.kind === "missing") {
      // The agent removed it. Only safe to remove if the user did not touch it.
      if (host.kind === "missing") continue
      if (sameContent(host, base) && entryKey(host) === entryKey(base)) {
        changes.push({ path: entry.path, kind: "delete", conflict: false, expectedHost: hostKey })
      } else {
        changes.push({ path: entry.path, kind: "delete", conflict: true, note: "you changed this file", expectedHost: hostKey })
      }
      continue
    }

    if (host.kind === "missing") {
      if (base.kind !== "missing") {
        // The user deleted it on purpose and the agent changed it. Resurrecting
        // it silently is data loss in the same way overwriting it would be.
        changes.push({
          path: entry.path,
          kind: sand.kind === "link" ? "link" : "add",
          conflict: true,
          note: "you deleted this file and the agent changed it",
          expectedHost: hostKey,
          linkTarget: sand.kind === "link" ? readLink(sandboxFile) : undefined,
        })
        continue
      }
      changes.push(plannedFor(sand, hostKey, entry.path, sandboxFile, "add"))
      continue
    }

    if (sameContent(host, sand)) {
      if (host.kind === "file" && sand.kind === "file" && host.mode !== sand.mode) {
        changes.push({ path: entry.path, kind: "mode", conflict: false, expectedHost: hostKey, mode: sand.mode, note: "permissions changed" })
      }
      continue
    }

    if (host.kind !== sand.kind) {
      changes.push({
        path: entry.path,
        kind: sand.kind === "link" ? "link" : "modify",
        conflict: true,
        note: "type changed (" + host.kind + " on the host, " + sand.kind + " in the sandbox)",
        expectedHost: hostKey,
      })
      continue
    }

    if (base.kind === "missing") {
      changes.push({
        path: entry.path,
        kind: sand.kind === "link" ? "link" : "add",
        conflict: true,
        note: "you created a file with this name while the agent was working",
        expectedHost: hostKey,
      })
      continue
    }

    if (sameContent(host, base) && entryKey(host) === entryKey(base)) {
      changes.push(plannedFor(sand, hostKey, entry.path, sandboxFile, "modify"))
      continue
    }

    if (sand.kind === "file" && host.kind === "file" && base.kind === "file") {
      changes.push(await attemptMerge(p, entry.path, hostFile, baseFile, sandboxFile, sand.mode))
      continue
    }

    changes.push({
      path: entry.path,
      kind: sand.kind === "link" ? "link" : "modify",
      conflict: true,
      note: "you and the agent both changed it",
      expectedHost: hostKey,
    })
  }

  // Name the credential before it moves, not after. The value can only come from
  // the host's own sources — the sandbox stores no credential, only a fingerprint —
  // so a key rotated since the boot is invisible here. docs/SPEC.md §4 says so.
  // Conflicts are skipped: moat never writes them, so it must not claim they leak.
  let credentialLeaks: string[] = []
  const values = knownCredentialValues()
  if (values.length === 0) {
    noteScanSkipped("apply")
  } else {
    const entries = changes
      .filter((change) => !change.conflict && (change.kind === "add" || change.kind === "modify" || change.kind === "merge"))
      .map((change) => ({
        path: change.path,
        file: change.kind === "merge" ? (change.mergedFile ?? "") : path.join(p.work, change.path),
      }))
      .filter((entry) => entry.file.length > 0)
    const scanned = leakingFiles(entries, values)
    credentialLeaks = scanned.leaks
    noteFilesTooLargeToScan(scanned.skipped, "apply")
    if (credentialLeaks.length > 0) {
      warnAboutCredentialLeak(credentialLeaks, "about to be written into your working tree")
    }
  }

  const conflicts = changes.filter((change) => change.conflict)
  return {
    changes,
    conflicts,
    added: changes.filter((change) => change.kind === "add" && !change.conflict).length,
    empty: changes.length === 0,
    baselineProblem: null,
    baselineCommit: baseline.commit,
    credentialLeaks,
  }
}

function readLink(file: string): string {
  try {
    return fs.readlinkSync(file)
  } catch {
    return ""
  }
}

/**
 * The destination must stay inside the project, even when the project contains
 * symlinks: writing through a symlink that points at, say, ~/.ssh would put
 * agent-chosen bytes outside the tree the user agreed to.
 */
export function safeDestination(root: string, rel: string): string | null {
  let realRoot: string
  try {
    realRoot = fs.realpathSync(root)
  } catch {
    return null
  }
  const abs = path.resolve(realRoot, rel)
  const relative = path.relative(realRoot, abs)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null

  const segments = relative.split(path.sep)
  let current = realRoot
  for (const segment of segments) {
    current = path.join(current, segment)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch {
      break
    }
    if (stat.isSymbolicLink()) {
      let target: string
      try {
        target = fs.realpathSync(current)
      } catch {
        return null
      }
      if (target !== realRoot && !target.startsWith(realRoot + path.sep)) return null
      current = target
    }
  }
  return abs
}

function copyAtomic(source: string, dest: string, mode?: number): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    if (fs.lstatSync(dest).isSymbolicLink()) fs.rmSync(dest, { force: true })
  } catch {
    /* nothing there */
  }
  const temp = path.join(path.dirname(dest), "." + path.basename(dest) + ".moat-" + process.pid)
  const bytes = fs.readFileSync(source)
  fs.writeFileSync(temp, bytes, mode !== undefined ? { mode } : undefined)
  if (mode !== undefined) fs.chmodSync(temp, mode)
  fs.renameSync(temp, dest)
}

/**
 * Write the plan to the user's directory.
 *
 * Conflicts are skipped, never written, and returned so the caller can say what
 * happened. Files the agent deleted are removed only when the user had not
 * touched them. Every change is re-checked against the state it was planned
 * from, so an edit made while the user was reading the plan is never lost.
 */
export async function applyPlan(p: EnvPaths, plan: ApplyPlan): Promise<{ applied: number; skipped: string[] }> {
  if (plan.baselineProblem) throw new Error(plan.baselineProblem)

  let applied = 0
  const skipped: string[] = []
  try {
    for (const change of plan.changes) {
      const dest = safeDestination(p.projectDir, change.path)
      if (change.conflict || dest === null) {
        skipped.push(change.path)
        continue
      }

      const now = entryKey(entryState(dest))
      if (change.expectedHost !== now) {
        skipped.push(change.path)
        continue
      }

      if (change.kind === "mode") {
        fs.chmodSync(dest, change.mode ?? 0o644)
        applied += 1
        continue
      }
      if (change.kind === "delete") {
        fs.rmSync(dest, { recursive: true, force: true })
        applied += 1
        continue
      }
      if (change.kind === "link") {
        fs.rmSync(dest, { force: true })
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.symlinkSync(change.linkTarget ?? "", dest)
        applied += 1
        continue
      }

      const source = change.kind === "merge" ? change.mergedFile : path.join(p.work, change.path)
      if (!source || !fs.existsSync(source)) {
        skipped.push(change.path)
        continue
      }
      copyAtomic(source, dest, change.mode)
      applied += 1
    }
  } finally {
    for (const change of plan.changes) if (change.mergedFile) fs.rmSync(change.mergedFile, { force: true })
  }

  return { applied, skipped }
}

export function describePlan(plan: ApplyPlan): string[] {
  const verbs: Record<ChangeKind, string> = {
    add: "add",
    modify: "update",
    delete: "remove",
    merge: "merge",
    mode: "chmod",
    link: "link",
  }
  return plan.changes
    .filter((change) => !change.conflict)
    .map((change) => {
      const note = change.note ? "  (" + change.note + ")" : ""
      return verbs[change.kind].padEnd(7) + " " + change.path + note
    })
}
