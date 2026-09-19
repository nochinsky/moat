import fs from "node:fs"

import { sandboxGit } from "../lib/git.ts"
import type { EnvPaths } from "../lib/paths.ts"
import { readRootfsFile } from "../lib/rootfs-fs.ts"
import { recoveredState, type EnvState } from "./state.ts"

/**
 * Rebuild an environment's state from what is still in its directory.
 *
 * Only called when `state.json` cannot be read *and* the rootfs still holds a
 * sandbox working tree. Every field is read from disk rather than assumed: the
 * branch and the copy-in baseline from the sandbox repository (through the
 * hardened runner, because that repository is agent-controlled), the Alpine
 * version from the rootfs, the creation time from the environment directory.
 *
 * What this is for: `state.json` is the only thing that says an environment
 * exists, but it is not where the environment's data lives. Without this, a
 * lost metadata file meant the next `moat up` provisioned over the rootfs and
 * destroyed the agent's branch, its uncommitted work and everything it had
 * installed — silently, and in flat contradiction of SPEC §2.2.
 */
export async function recoverStateFromDisk(p: EnvPaths): Promise<EnvState> {
  const head = await sandboxGit(p.work, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true })
  const branch = head.code === 0 ? head.stdout.trim() : ""
  const baseline = await sandboxGit(p.work, ["rev-parse", "--verify", "--quiet", "refs/moat/baseline"], {
    allowFailure: true,
  })
  let createdAt: string | null = null
  try {
    createdAt = fs.statSync(p.dir).birthtime.toISOString()
  } catch {
    createdAt = null
  }
  return recoveredState(p, {
    // A detached HEAD answers with the literal "HEAD"; that is not a branch name.
    branch: branch && branch !== "HEAD" ? branch : null,
    baselineCommit: baseline.code === 0 ? baseline.stdout.trim() || null : null,
    alpineVersion: readRootfsFile(p.rootfs, "/etc/alpine-release")?.trim() || null,
    createdAt,
  })
}
