import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { partPath, type EnvPaths } from "../lib/paths.ts"
import { applyHunks, hunksBetween, type Hunk } from "../lib/hunks.ts"
export type { Hunk } from "../lib/hunks.ts"
import { run } from "../lib/shell.ts"
import { SANITIZED_GIT_ENV, sandboxGit, sandboxGitRaw } from "../lib/git.ts"
import {
  injectedCredentialVarNames,
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
  /**
   * kind === 'add' | 'modify': the host-side file holding the bytes to write.
   *
   * Frozen at plan time from the sandbox file, instead of the apply step reading
   * `<sandbox>/<path>` again. Two things went wrong with reading it again: the file
   * the credential scan examined and the file that got written were not necessarily
   * the same bytes, and the sandbox path is agent-controlled, so a symlink swapped in
   * between planning and applying pulled a *host* file into the project — the exact
   * direction of travel this tool exists to prevent. The copy also normalises the
   * path: the temp file lives outside the rootfs, so nothing the agent can still
   * reach is on the write path.
   */
  sourceFile?: string
  /** kind === 'link': the symlink target to create. */
  linkTarget?: string
  /** File mode to set after writing (kind === 'mode' sets it on its own). */
  mode?: number
}

export type ApplyPlan = {
  /** Every changed path, conflicts included. */
  changes: PlannedChange[]
  /** The conflicting rows of `changes`, in the same order. A subset, not a second list. */
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
    if (
      !name.startsWith("moat-merge-") &&
      !name.startsWith("moat-theirs-") &&
      !name.startsWith("moat-source-") &&
      name !== "merged.tmp"
    )
      continue
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

/**
 * Freeze a sandbox file's bytes on the host, outside the rootfs.
 *
 * The temp lives in the environment's `runtime/` directory, which the agent inside
 * the box cannot reach, and its name is unique per call (`partPath`), so two plans in
 * flight cannot take each other's inputs. The read happens once, here, so what the
 * credential scan inspects is byte-for-byte what `applyPlan` writes.
 */
function freezeSource(p: EnvPaths, sandboxFile: string): string | undefined {
  const dir = path.join(p.dir, "runtime")
  try {
    fs.mkdirSync(dir, { recursive: true })
    const dest = partPath(path.join(dir, "moat-source"))
    // A symlink or a directory in the sandbox is not content to copy: those are
    // planned as `link` or skipped, and never reach here as a file.
    if (!fs.lstatSync(sandboxFile).isFile()) return undefined
    fs.copyFileSync(sandboxFile, dest)
    fs.chmodSync(dest, 0o600)
    return dest
  } catch {
    return undefined
  }
}

function plannedFor(
  p: EnvPaths,
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
    return {
      path: changePath,
      kind,
      conflict: false,
      expectedHost: hostKey,
      mode: sand.mode,
      sourceFile: freezeSource(p, sandboxFile),
    }
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
      changes.push(plannedFor(p, sand, hostKey, entry.path, sandboxFile, "add"))
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
      changes.push(plannedFor(p, sand, hostKey, entry.path, sandboxFile, "modify"))
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
  const values = knownCredentialValues(process.env, undefined, { alsoNames: injectedCredentialVarNames(p) })
  if (values.length === 0) {
    noteScanSkipped("apply")
  } else {
    const entries = changes
      .filter((change) => !change.conflict && (change.kind === "add" || change.kind === "modify" || change.kind === "merge"))
      .map((change) => ({
        path: change.path,
        file: change.kind === "merge" ? (change.mergedFile ?? "") : (change.sourceFile ?? ""),
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

      // The bytes that were scanned, frozen at plan time. Re-reading the sandbox
      // path here is how the scan verdict and the written bytes could differ, and how
      // a symlink swapped into the agent's tree pulled a host file into the project.
      const source = change.kind === "merge" ? change.mergedFile : change.sourceFile
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

/**
 * The plan, as a reviewer sees it: one row per changed path, with its hunks.
 *
 * This is the review surface's data, and it is deliberately a *presentation* of `planApply`'s
 * answer rather than a second opinion about it. `verdict` is the planner's classification, `note`
 * is the planner's own words for why, and `conflict` is the planner's refusal. The only thing
 * added here is the split into hunks.
 *
 * A path the planner refused (`conflict: true`) is still listed, with no hunks: the reviewer has
 * to be able to see that it was considered and why it was not written. It can never be accepted —
 * `applySelection` refuses it — so listing it is information, not an option.
 */
export type ReviewedChange = {
  path: string
  /** The planner's classification, carried through rather than re-derived. */
  verdict: "agent" | "you" | "both" | "conflict"
  kind: ChangeKind
  /** The planner's own note, for the reviewer. */
  note?: string
  /** The file the proposed content was frozen into at plan time, outside the rootfs. */
  sourceFile?: string
  hunks: Hunk[]
  /** False for `delete`/`mode`/`link`, and for a diff that could not be produced. */
  partial: boolean
  /** True when the planner refused this change; nothing may write it. */
  conflict: boolean
}

export async function reviewPlan(p: EnvPaths, plan: ApplyPlan): Promise<ReviewedChange[]> {
  const rows: ReviewedChange[] = []
  for (const row of planVerdict(plan)) {
    const change = [...plan.changes, ...plan.conflicts].find((entry) => entry.path === row.path)
    if (!change) continue
    // `delete`, `mode` and `link` have nothing to split: the change is the path.
    const divisible = !change.conflict && (change.kind === "add" || change.kind === "modify" || change.kind === "merge")
    const dest = safeDestination(p.projectDir, change.path)
    const source = change.kind === "merge" ? change.mergedFile : change.sourceFile
    let hunks: Hunk[] = []
    if (divisible && dest !== null && source && fs.existsSync(source)) {
      const proposed = fs.readFileSync(source, "utf8")
      // The hunks are always `your file` -> `the proposed content`, for a merge as much as for a
      // modify. Two bugs lived in the one line this replaces:
      //
      //  - a merge diffed the merged content against *itself*, so a merge that changed anything
      //    reported zero hunks and `--hunks` refused it as "not divisible";
      //  - anchoring a merge to the merged bytes would have made a rejected hunk vanish rather
      //    than stay out: rewriting from `merged + accepted hunks` re-applies every hunk that was
      //    not explicitly rejected, because the merged bytes already contain them.
      //
      // Anchoring to your file is right for both: rejecting a hunk leaves your own line, because
      // your own line is what the hunk's range holds.
      const current = entryState(dest).kind === "file" ? fs.readFileSync(dest, "utf8") : ""
      hunks = (await hunksBetween(current, proposed)) ?? []
      // A diff that could not be produced (a binary file, or a git that refused) falls back to
      // path-level: the file is still offered, just not divisible. Saying "one hunk" here would be
      // a promise the writer cannot keep.
    }
    rows.push({
      path: change.path,
      verdict: row.verdict,
      kind: change.kind,
      ...(row.detail ? { note: row.detail } : {}),
      ...(source ? { sourceFile: source } : {}),
      ...(dest !== null && change.kind !== "add" ? { destFile: dest } : {}),
      hunks,
      partial: divisible && hunks.length > 0,
      conflict: Boolean(change.conflict),
    })
  }
  return rows
}

/**
 * What a reviewer decided about one path.
 *
 * `accepted: null` means "the whole file" — every hunk, or for a `delete`/`mode`/`link` the change
 * itself. An empty set means "none of it", which is the same outcome as refusing the path but is
 * recorded differently so the report can say which happened.
 */
export type Selection = { path: string; accepted: number[] | null }

/** The outcome of writing a selection, per path. */
export type SelectionResult = {
  applied: { path: string; hunks: number; mode: "whole" | "partial" }[]
  skipped: { path: string; reason: string }[]
}

/**
 * Write the accepted hunks of a plan to the user's directory.
 *
 * Safety properties, each of which is why this is a separate function from `applyPlan` rather than
 * a flag on it:
 *
 *  - **A conflict is never written.** The check is the plan's `conflict` flag, not the selection,
 *    so no selection can talk moat into writing one.
 *  - **The three-way re-check still happens, immediately before the write.** `expectedHost` is
 *    compared against the destination's *current* state for every path, and a file edited since
 *    the plan was made is skipped exactly as before.
 *  - **The written bytes come from the destination plus the frozen source.** The destination's
 *    content is the one that was just verified, and the replacement lines come from the file
 *    frozen at plan time — never a fresh read of the agent's tree. A symlink swapped in after the
 *    plan cannot reach this write.
 *  - **A rejected hunk stays out.** Hunks are anchored to the destination, so a path with hunks 1
 *    and 3 accepted and 2 rejected contains the agent's lines in 1 and 3 and the host's own line
 *    where 2 would have been.
 */
export async function applySelection(
  p: EnvPaths,
  plan: ApplyPlan,
  selections: Selection[],
): Promise<SelectionResult> {
  if (plan.baselineProblem) throw new Error(plan.baselineProblem)
  const chosen = new Map(selections.map((entry) => [entry.path, entry.accepted]))
  const result: SelectionResult = { applied: [], skipped: [] }

  try {
    for (const change of plan.changes) {
      if (!chosen.has(change.path)) continue
      const dest = safeDestination(p.projectDir, change.path)
      if (change.conflict) {
        // Unreachable through `reviewPlan`, which offers no hunks for a conflict, and kept anyway:
        // "no selection may cause a conflicting file to be written" is the invariant, and an
        // invariant that depends on a caller's good behaviour is not one.
        result.skipped.push({ path: change.path, reason: "conflicting: moat never writes one" })
        continue
      }
      if (dest === null) {
        result.skipped.push({ path: change.path, reason: "outside the project directory" })
        continue
      }
      if (entryKey(entryState(dest)) !== change.expectedHost) {
        result.skipped.push({ path: change.path, reason: "changed on the host since the plan was made" })
        continue
      }
      // A path absent from the selection map is "not selected", which is a *third* thing next to
      // `null` ("the whole file") and `[]` ("none of it"). The map is read without a default so all
      // three survive to here: `?? []` would answer `[]` for a `null` value too, making "the whole
      // file" unreachable, and `?? null` was the original bug in the other direction — an absent
      // path arrived at it as the whole-file form and was written in full. The guard on the line
      // above is what keeps that from happening, and this is measured rather than asserted:
      // deleting it fails `accepting nothing writes nothing at all` in `test/unit/review.test.ts`:
      // the unselected path arrives at the default below and is written in full.
      const accepted = chosen.get(change.path) ?? null
      if (accepted !== null && accepted.length === 0) {
        result.skipped.push({ path: change.path, reason: "you accepted none of it" })
        continue
      }

      if (change.kind === "mode") {
        fs.chmodSync(dest, change.mode ?? 0o644)
        result.applied.push({ path: change.path, hunks: 0, mode: "whole" })
        continue
      }
      if (change.kind === "delete") {
        fs.rmSync(dest, { recursive: true, force: true })
        result.applied.push({ path: change.path, hunks: 0, mode: "whole" })
        continue
      }
      if (change.kind === "link") {
        fs.rmSync(dest, { force: true })
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.symlinkSync(change.linkTarget ?? "", dest)
        result.applied.push({ path: change.path, hunks: 0, mode: "whole" })
        continue
      }

      const source = change.kind === "merge" ? change.mergedFile : change.sourceFile
      if (!source || !fs.existsSync(source)) {
        result.skipped.push({ path: change.path, reason: "the planned bytes are no longer available" })
        continue
      }
      const proposed = fs.readFileSync(source, "utf8")

      if (accepted === null) {
        copyAtomic(source, dest, change.mode)
        result.applied.push({ path: change.path, hunks: 0, mode: "whole" })
        continue
      }

      // Partial: the destination as it is now (just verified) plus the accepted hunks, anchored
      // to the destination so a rejected hunk keeps the host's own line. See `reviewPlan` for why
      // a merge is anchored here rather than to the merged bytes.
      const current = change.kind === "add" ? "" : fs.readFileSync(dest, "utf8")
      const hunks = (await hunksBetween(current, proposed)) ?? []
      const wanted = new Set(accepted)
      // Accepting every hunk means "the whole file", so the bytes written are the frozen proposed
      // content rather than a re-derivation of it. The two are equal by construction, and this is
      // what makes that true by *use* as well: a re-derived equal-length buffer is a chance to
      // write something the user did not review, and the cost of being sure is nothing here.
      const next = hunks.length > 0 && wanted.size >= hunks.length ? proposed : applyHunks(current, hunks, wanted)
      writeAtomic(dest, next, change.mode)
      result.applied.push({ path: change.path, hunks: wanted.size, mode: "partial" })
    }
  } catch (error) {
    // A failure part-way through leaves the plan's frozen files in place rather than deleting
    // them: the plan is a description of work, and a caller that saw an error may want to retry it
    // or hand it to `applyPlan`. `cleanupMergeTemps` reaps them an hour later either way.
    throw error
  }

  // The plan's temps are deliberately *not* deleted here, and that is the fix for a real bug:
  // consuming them on the first call made a plan single-use by accident. The unit test that
  // caught it applies a selection, is refused for a stale host, re-plans, and applies again — and
  // the second call on the same plan found `mergedFile` already gone and reported "the planned
  // bytes are no longer available" while looking exactly like a write that had happened.
  // `cleanupMergeTemps` reaps abandoned ones by age, which is the mechanism that already existed.
  return result
}

/** Also called by `applyHunks`; the shared writer keeps the mode handling in one place. */
function writeAtomic(dest: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    if (fs.lstatSync(dest).isSymbolicLink()) fs.rmSync(dest, { force: true })
  } catch {
    /* nothing there */
  }
  const temp = partPath(dest)
  fs.writeFileSync(temp, content, mode !== undefined ? { mode } : undefined)
  if (mode !== undefined) fs.chmodSync(temp, mode)
  fs.renameSync(temp, dest)
}

/**
 * Every changed path, classified: the agent's, yours, or both.
 *
 * The classification is not computed here — it is already in the plan, in the `conflict` flag and
 * the `note` that the comparison above wrote. This maps it into the three words a person reads,
 * so `moat take` and `moat demo` present what the planner decided rather than their own opinion
 * of it. A second classification would be free to disagree with the one that decides what gets
 * written, and the disagreement would show up as a file the user was told was theirs and then
 * overwritten.
 *
 * "yours" is derived rather than compared: the planner only lists paths the *agent* touched, so
 * a path it flags as the user's is one the agent also changed. A file only you changed is not in
 * the plan at all — there is nothing to do about it — which is why it cannot appear here.
 */
export function planVerdict(plan: ApplyPlan): { path: string; verdict: "agent" | "you" | "both" | "conflict"; detail: string }[] {
  const rows: { path: string; verdict: "agent" | "you" | "both" | "conflict"; detail: string }[] = []
  // `plan.conflicts` is a *subset* of `plan.changes` (see the type), so walking both listed every
  // conflict twice. A path appears once in a plan by construction — the planner builds one row per
  // changed path — so deduplicating here cannot hide a second verdict for the same file.
  const seen = new Set<string>()
  for (const change of [...plan.changes, ...plan.conflicts]) {
    if (seen.has(change.path)) continue
    seen.add(change.path)
    const note = change.note ?? ""
    const verdict = change.conflict
      ? "conflict"
      : change.kind === "merge"
        ? "both"
        : /^you changed this file/.test(note)
          ? "you"
          : "agent"
    rows.push({ path: change.path, verdict, detail: note })
  }
  return rows.sort((a, b) => (a.path < b.path ? -1 : 1))
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
