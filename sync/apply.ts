import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { EnvPaths } from "../lib/paths.ts"
import { run } from "../lib/shell.ts"
import { SANITIZED_GIT_ENV } from "./copyin.ts"

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
 */

export type ChangeKind = "add" | "modify" | "delete" | "merge"

export type PlannedChange = {
  path: string
  kind: ChangeKind
  /** True when moat will not touch this file. */
  conflict: boolean
  note?: string
}

export type ApplyPlan = {
  changes: PlannedChange[]
  conflicts: PlannedChange[]
  /** Files the agent produced that would become new files on the host. */
  added: number
  /** True when there is nothing to do at all. */
  empty: boolean
}

function hashFile(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  } catch {
    return null
  }
}

/** Materialise the baseline tree so the host can be compared against it. */
async function materialiseBaseline(p: EnvPaths): Promise<string | null> {
  const baseline = await run("git", ["-C", p.work, "rev-parse", "--verify", "--quiet", "refs/moat/baseline"], {
    env: SANITIZED_GIT_ENV,
    allowFailure: true,
  })
  if (baseline.code !== 0) return null

  const dir = path.join(p.dir, "baseline")
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const tar = await run("git", ["-C", p.work, "archive", "--format=tar", "refs/moat/baseline"], {
    env: SANITIZED_GIT_ENV,
    allowFailure: true,
  })
  if (tar.code !== 0) return null
  const extract = await run("tar", ["-xf", "-", "-C", dir], { input: tar.stdout, allowFailure: true })
  return extract.code === 0 ? dir : null
}

/** Every path the agent has touched, relative to the baseline. */
async function agentChanges(p: EnvPaths): Promise<{ path: string; status: string }[]> {
  const diff = await run(
    "git",
    ["-C", p.work, "diff", "--name-status", "--no-renames", "refs/moat/baseline"],
    { env: SANITIZED_GIT_ENV, allowFailure: true },
  )
  const tracked = diff.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status = "", ...rest] = line.split(/\s+/)
      return { status: status.charAt(0), path: rest.join(" ") }
    })

  const untracked = await run("git", ["-C", p.work, "ls-files", "-o", "--exclude-standard"], {
    env: SANITIZED_GIT_ENV,
    allowFailure: true,
  })
  const added = untracked.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => ({ status: "A", path: file }))

  // A file can appear in both lists if it was committed and then touched again.
  const merged = new Map<string, string>()
  for (const entry of [...tracked, ...added]) merged.set(entry.path, entry.status)
  return [...merged].map(([file, status]) => ({ path: file, status }))
}

/**
 * Work out what applying would do, without doing any of it.
 *
 * Written so the caller can show the user first. `moat apply` prints this, and
 * the interactive session shows it before asking.
 */
export async function planApply(p: EnvPaths): Promise<ApplyPlan> {
  const baselineDir = await materialiseBaseline(p)
  const changes: PlannedChange[] = []

  if (baselineDir) {
    for (const entry of await agentChanges(p)) {
      const sandboxFile = path.join(p.work, entry.path)
      const hostFile = path.join(p.projectDir, entry.path)
      const baseFile = path.join(baselineDir, entry.path)

      const baseHash = hashFile(baseFile)
      const hostHash = hashFile(hostFile)
      const sandboxExists = fs.existsSync(sandboxFile) && fs.statSync(sandboxFile).isFile()

      if (entry.status === "D" || !sandboxExists) {
        // The agent removed it. Only safe to remove if the user did not touch it.
        if (hostHash === null) continue
        if (hostHash === baseHash) changes.push({ path: entry.path, kind: "delete", conflict: false })
        else changes.push({ path: entry.path, kind: "delete", conflict: true, note: "you changed this file" })
        continue
      }

      if (hostHash === null) {
        changes.push({ path: entry.path, kind: "add", conflict: false })
        continue
      }

      const sandboxHash = hashFile(sandboxFile)
      if (hostHash === sandboxHash) continue // already identical
      if (baseHash === null) {
        // The file did not exist when moat copied, and it exists on the host now
        // with different content: the user created it too. Overwriting that is
        // exactly the mistake this whole file exists to avoid.
        changes.push({
          path: entry.path,
          kind: "add",
          conflict: true,
          note: "you created a file with this name while the agent was working",
        })
        continue
      }
      if (hostHash === baseHash) {
        changes.push({ path: entry.path, kind: "modify", conflict: false })
        continue
      }

      // Both sides changed it. Try a real merge before giving up.
      const mine = path.join(p.dir, "runtime", "mine.tmp")
      const theirs = path.join(p.dir, "runtime", "theirs.tmp")
      fs.mkdirSync(path.dirname(mine), { recursive: true })
      fs.copyFileSync(hostFile, mine)
      fs.copyFileSync(sandboxFile, theirs)
      const merged = await run("git", ["merge-file", "-p", mine, baseFile, theirs], { allowFailure: true })
      fs.rmSync(mine, { force: true })
      fs.rmSync(theirs, { force: true })
      if (merged.code === 0) {
        fs.writeFileSync(path.join(p.dir, "runtime", "merged.tmp"), merged.stdout)
        changes.push({ path: entry.path, kind: "merge", conflict: false, note: "both changed it; merged" })
      } else {
        changes.push({
          path: entry.path,
          kind: "merge",
          conflict: true,
          note: "you and the agent both changed it, and the changes overlap",
        })
      }
    }
  }

  const conflicts = changes.filter((c) => c.conflict)
  return {
    changes,
    conflicts,
    added: changes.filter((c) => c.kind === "add").length,
    empty: changes.length === 0,
  }
}

/**
 * Write the plan to the user's directory.
 *
 * Conflicts are skipped, never written, and returned so the caller can say what
 * happened. Files the agent deleted are removed only when the user had not
 * touched them.
 */
export async function applyPlan(p: EnvPaths, plan: ApplyPlan): Promise<{ applied: number; skipped: string[] }> {
  let applied = 0
  const skipped: string[] = []

  for (const change of plan.changes) {
    const hostFile = path.join(p.projectDir, change.path)
    if (change.conflict) {
      skipped.push(change.path)
      continue
    }
    if (change.kind === "delete") {
      fs.rmSync(hostFile, { force: true })
      applied += 1
      continue
    }
    const source =
      change.kind === "merge" ? path.join(p.dir, "runtime", "merged.tmp") : path.join(p.work, change.path)
    fs.mkdirSync(path.dirname(hostFile), { recursive: true })
    fs.copyFileSync(source, hostFile)
    const mode = fs.statSync(path.join(p.work, change.path)).mode & 0o777
    fs.chmodSync(hostFile, mode)
    applied += 1
  }

  fs.rmSync(path.join(p.dir, "runtime", "merged.tmp"), { force: true })
  return { applied, skipped }
}

export function describePlan(plan: ApplyPlan): string[] {
  return plan.changes
    .filter((change) => !change.conflict)
    .map((change) => {
      const verb = change.kind === "add" ? "add" : change.kind === "delete" ? "remove" : change.kind === "merge" ? "merge" : "update"
      return `${verb.padEnd(7)} ${change.path}${change.note ? `  (${change.note})` : ""}`
    })
}
