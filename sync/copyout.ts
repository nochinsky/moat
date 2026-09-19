import fs from "node:fs"

import type { EnvPaths } from "../lib/paths.ts"
import { run } from "../lib/shell.ts"
import * as log from "../lib/log.ts"
import { SANITIZED_GIT_ENV, resolveGitDir, sandboxGit, withSanitizedSandboxRepo } from "../lib/git.ts"
import {
  fetchedRevs,
  knownCredentialValues,
  noteScanSkipped,
  scanCommittedForCredentials,
  warnAboutCredentialLeak,
} from "./leak-scan.ts"

/**
 * Copy-out.
 *
 * The agent commits inside the sandbox to a branch. The host, and only the
 * host, and only when the user runs `moat fetch`, runs `git fetch` with the
 * sandbox's repository as the remote. Nothing is ever auto-applied.
 *
 * Two guarantees this module is responsible for:
 *
 *  1. The working tree is untouched. `moat fetch` adds objects to `.git` and
 *     creates exactly one ref under `refs/moat/`. It does not move HEAD and
 *     does not touch the index or any tracked file. `moat apply` is a separate,
 *     explicitly-requested step.
 *  2. Only the branch the user asked for is brought across. Fetching is always
 *     scoped to a single refspec.
 */

export type SandboxBranch = {
  name: string
  sha: string
  subject: string
  committedAt: string
  current: boolean
}

export type FetchResult = {
  branch: string
  hostRef: string
  sha: string
  commits: number
  headBefore: string | null
  headAfter: string | null
  /** The host's HEAD did not move. The full tree proof is the digest in cmd/main.ts. */
  headUnchanged: boolean
  commitsFetched: { sha: string; subject: string }[]
  /**
   * Files in the fetched commits whose content contains the credential moat
   * injected into the sandbox. Those objects are now in the host repository's
   * `.git`; empty when the host has no credential value to compare against.
   */
  credentialLeaks: string[]
}

export async function sandboxRepoExists(p: EnvPaths): Promise<boolean> {
  // A .git file or symlink is not a repository the host may run git in; the
  // hardened runner refuses it, so report it as absent here instead of failing
  // later with a confusing message.
  return resolveGitDir(p.work) !== null
}

export async function listSandboxBranches(p: EnvPaths): Promise<SandboxBranch[]> {
  const format = "%(refname:short)%00%(objectname)%00%(subject)%00%(committerdate:iso-strict)"
  const result = await sandboxGit(p.work, ["for-each-ref", `--format=${format}`, "refs/heads"], { allowFailure: true })
  const current = (await sandboxGit(p.work, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true })).stdout.trim()
  return result.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [name = "", sha = "", subject = "", committedAt = ""] = line.split("\0")
      return { name, sha, subject, committedAt, current: name === current }
    })
}

/**
 * Uncommitted changes sitting in the sandbox working tree.
 *
 * These are NOT collected by `moat fetch`: it fetches a branch ref, and
 * uncommitted work is in no ref. Left alone it simply stays in the box, which is
 * fine until someone assumes otherwise. So it is measured and reported.
 */
export async function sandboxWorktreeChanges(p: EnvPaths): Promise<string[]> {
  if (!(await sandboxRepoExists(p))) return []
  const result = await sandboxGit(p.work, ["status", "--porcelain", "-z"], { allowFailure: true })
  return result.stdout
    .split("\0")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Commit the sandbox working tree on the user's behalf, so that work the agent
 * left uncommitted can be fetched.
 *
 * Only ever called because the user asked for it (`moat fetch --commit-worktree`).
 * Nothing in moat commits to a sandbox branch on its own.
 */
export async function commitSandboxWorktree(
  p: EnvPaths,
  message: string,
): Promise<{ sha: string | null; files: number }> {
  const env = {
    ...SANITIZED_GIT_ENV,
    GIT_AUTHOR_NAME: "moat agent",
    GIT_AUTHOR_EMAIL: "agent@moat.invalid",
    GIT_COMMITTER_NAME: "moat agent",
    GIT_COMMITTER_EMAIL: "agent@moat.invalid",
  }
  const changes = await sandboxWorktreeChanges(p)
  if (changes.length === 0) return { sha: null, files: 0 }

  // The hardened runner disables hooks for the duration: a commit triggered by
  // the host must never execute a pre-commit hook the agent wrote.
  await sandboxGit(p.work, ["add", "-A"], { env })
  const commit = await sandboxGit(p.work, ["commit", "--quiet", "-m", message], { env, allowFailure: true })
  if (commit.code !== 0) {
    throw new Error(`could not commit the sandbox working tree: ${commit.stderr.trim() || commit.stdout.trim()}`)
  }
  return { sha: await sandboxHead(p), files: changes.length }
}

export async function sandboxHead(p: EnvPaths): Promise<string | null> {
  const result = await sandboxGit(p.work, ["rev-parse", "HEAD"], { allowFailure: true })
  return result.code === 0 ? result.stdout.trim() : null
}

/**
 * The default branch to offer when the user does not name one: the sandbox's
 * current branch if it has commits the host does not have, else nothing.
 */
export async function suggestBranch(p: EnvPaths): Promise<string | null> {
  const branches = await listSandboxBranches(p)
  if (branches.length === 0) return null
  const current = branches.find((b) => b.current)

  // Prefer a branch whose tip the host cannot already reach: offering a branch
  // that was fetched on a previous run would look like new work and not be.
  const unknown = async (b: SandboxBranch): Promise<boolean> => !(await hostHasCommit(p.projectDir, b.sha))
  if (current && (await unknown(current))) return current.name
  for (const branch of branches) {
    if (await unknown(branch)) return branch.name
  }
  return current?.name ?? branches[0]!.name
}

/** Does the host repository already contain this commit? */
async function hostHasCommit(projectDir: string, sha: string): Promise<boolean> {
  const known = await run("git", ["-C", projectDir, "cat-file", "-e", `${sha}^{commit}`], {
    env: SANITIZED_GIT_ENV,
    allowFailure: true,
  })
  return known.code === 0
}

export async function hostHead(projectDir: string): Promise<string | null> {
  const result = await run("git", ["-C", projectDir, "rev-parse", "HEAD"], { env: SANITIZED_GIT_ENV, allowFailure: true })
  return result.code === 0 ? result.stdout.trim() : null
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const result = await run("git", ["-C", dir, "rev-parse", "--git-dir"], { env: SANITIZED_GIT_ENV, allowFailure: true })
  return result.code === 0
}

export async function fetchBranch(
  p: EnvPaths,
  branch: string,
  opts: { remote?: string; limit?: number; refPrefix?: string } = {},
): Promise<FetchResult> {
  const refPrefix = opts.refPrefix ?? "refs/moat"
  const remote = opts.remote ?? p.work
  const hostRef = `${refPrefix}/${branch}`

  if (!(await isGitRepo(p.projectDir))) {
    throw new Error(
      `${p.projectDir} is not a git repository, so there is no ref to fetch into.\n` +
        "  moat apply still works here: it merges the sandbox's tree into this directory with a three-way merge.",
    )
  }
  if (!(await sandboxRepoExists(p))) {
    throw new Error(`no repository in the sandbox at ${p.work}. Run \`moat up\` first.`)
  }

  const headBefore = await hostHead(p.projectDir)

  // A single refspec, forced so a re-fetch updates in place. `--no-tags` keeps
  // the agent's tag namespace out of the user's repository.
  const refspec = `+refs/heads/${branch}:${hostRef}`
  log.step(`copy-out: git fetch ${remote} ${refspec}`)
  // Fetch runs in the *host* repository but the remote side is the sandbox's, so
  // upload-pack reads the agent-controlled config unless it is neutralized for
  // the duration of the fetch.
  const result = await withSanitizedSandboxRepo(p.work, () =>
    run("git", ["-C", p.projectDir, "fetch", "--no-tags", remote, refspec], {
      env: SANITIZED_GIT_ENV,
      allowFailure: true,
    }),
  )
  if (result.code !== 0) throw new Error(`git fetch from the sandbox failed: ${result.stderr.trim()}`)

  const sha = (await run("git", ["-C", p.projectDir, "rev-parse", hostRef], { env: SANITIZED_GIT_ENV })).stdout.trim()

  const limit = opts.limit ?? 20
  const logResult = await run(
    "git",
    ["-C", p.projectDir, "log", `--max-count=${limit}`, "--format=%H%x00%s", hostRef],
    { env: SANITIZED_GIT_ENV, allowFailure: true },
  )
  const commitsFetched = logResult.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [commitSha = "", subject = ""] = line.split("\0")
      return { sha: commitSha, subject }
    })

  const headAfter = await hostHead(p.projectDir)

  // What just landed is the agent's content, and the agent can read the credential.
  // The scan covers every commit the fetch brought in, not just the tip, so content
  // committed and then deleted in a later commit is still named. It compares against
  // the credential values this host can see now — a rotated key is invisible.
  let credentialLeaks: string[] = []
  const values = knownCredentialValues()
  if (values.length === 0) {
    noteScanSkipped("fetch")
  } else {
    const searched = await fetchedRevs(p.projectDir, hostRef, headBefore)
    if (searched.truncated) {
      log.warn(
        `copy-out: only the ${searched.revs.length} most recent commit(s) were searched for the credential; ` +
          "the older commits this fetch brought in were not. Review them, or ask for a smaller branch.",
      )
    }
    credentialLeaks = await scanCommittedForCredentials(p.projectDir, searched.revs, values)
    if (credentialLeaks.length > 0) {
      warnAboutCredentialLeak(credentialLeaks, "in the branch just fetched")
    }
  }

  return {
    branch,
    hostRef,
    sha,
    commits: commitsFetched.length,
    headBefore,
    headAfter,
    headUnchanged: headBefore === headAfter,
    commitsFetched,
    credentialLeaks,
  }
}

/**
 * How many commits exist in the sandbox that the host cannot already reach.
 *
 * "Cannot reach" means unreachable from *any* host ref, including the
 * `refs/moat/*` refs that `moat fetch` creates: once the user has fetched, the work
 * is safely on the host, and re-copying the project is lossless.
 *
 * **Every branch counts, not just the sandbox's HEAD.** Measured: an agent left a
 * commit on `experiment` and switched back to the session branch; the next `moat up`
 * after the host project changed re-copied the project over it, and the branch, the
 * commit and the file were gone. This function looked only at HEAD, found nothing the
 * host lacked, and told the user the sandbox "holds nothing that is not already on
 * the host". The same undercount disabled the `--fresh` gate, which is supposed to
 * demand `--yes` when the sandbox holds unfetched work.
 *
 * A host that is not a git repository has no refs to compare against, so every
 * commit the agent added to the sandbox repository counts; the old code returned 0
 * there, which is the same false "nothing to lose".
 */
export async function countUnfetched(p: EnvPaths): Promise<number> {
  if (!(await sandboxRepoExists(p))) return 0
  // Tags too: `git fetch --no-tags` never brings them across, and a commit kept
  // alive only by a tag in the box is still work that a re-copy would destroy.
  const tips = (
    await sandboxGit(p.work, ["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/tags"], { allowFailure: true })
  ).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (tips.length === 0) return 0

  // A count of 0 is a real answer, not a failed command: `|| fallback` reads it as
  // falsy and reports work that is not there. Parse, then fall back only on NaN.
  const parseCount = (stdout: string, fallback: number): number => {
    const parsed = Number.parseInt(stdout.trim(), 10)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  if (!(await isGitRepo(p.projectDir))) {
    // No host repository: nothing in the sandbox is on the host. Count what the
    // agent added, relative to the baseline moat recorded at copy-in. If the
    // baseline is gone too, the tip count is the safe lower bound.
    const count = await sandboxGit(p.work, ["rev-list", "--count", ...tips, "--not", "refs/moat/baseline"], {
      allowFailure: true,
    })
    return parseCount(count.stdout, tips.length)
  }

  const known: string[] = []
  const unknown: string[] = []
  for (const tip of tips) {
    const present = await run("git", ["-C", p.projectDir, "cat-file", "-e", `${tip}^{commit}`], {
      env: SANITIZED_GIT_ENV,
      allowFailure: true,
    })
    ;(present.code === 0 ? known : unknown).push(tip)
  }

  let total = 0
  if (known.length > 0) {
    // The host has the objects, so it can answer precisely: commits reachable from
    // these tips but from no host ref.
    const count = await run("git", ["-C", p.projectDir, "rev-list", "--count", ...known, "--not", "--all"], {
      env: SANITIZED_GIT_ENV,
      allowFailure: true,
    })
    total += parseCount(count.stdout, 0)
  }
  if (unknown.length > 0) {
    // Tips the host has never seen. Count them against everything the sandbox can prove
    // the host already has: the clone-time remotes, plus the tips the host holds objects
    // for. The second half matters for a half-fetched branch — the old tip is on the
    // host under refs/moat/*, the new one is not, and only the new one is work. A later
    // host fetch cannot contain these tips (the host does not have their objects at
    // all), so this cannot undercount.
    const remoteTips = (
      await sandboxGit(p.work, ["for-each-ref", "--format=%(objectname)", "refs/remotes"], { allowFailure: true })
    ).stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    // Refs the host holds that the sandbox also has objects for: refs/moat/* from an
    // earlier fetch, the user's own branches, tags. Without these, a branch that was
    // fetched and then advanced is counted twice — the old tip is on the host, the new
    // one is not, and only the new one is work.
    const hostTips: string[] = []
    const hostRefs = await run(
      "git",
      ["-C", p.projectDir, "for-each-ref", "--format=%(objectname)", "refs/moat", "refs/heads", "refs/tags"],
      { env: SANITIZED_GIT_ENV, allowFailure: true },
    )
    for (const tip of hostRefs.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)) {
      const here = await sandboxGit(p.work, ["cat-file", "-e", `${tip}^{commit}`], { allowFailure: true })
      if (here.code === 0) hostTips.push(tip)
    }
    const exclude = [...remoteTips, ...known, ...hostTips]
    const args = ["rev-list", "--count", ...unknown]
    if (exclude.length > 0) args.push("--not", ...exclude)
    const count = await sandboxGit(p.work, args, { allowFailure: true })
    total += parseCount(count.stdout, unknown.length)
  }
  return total
}

/**
 * The explicit second step: turn a fetched ref into a local branch. Refuses to
 * move a dirty working tree, and never checks anything out unless asked.
 */
export async function applyBranch(
  p: EnvPaths,
  branch: string,
  opts: { name?: string; checkout?: boolean; refPrefix?: string } = {},
): Promise<{ branch: string; ref: string }> {
  const refPrefix = opts.refPrefix ?? "refs/moat"
  const ref = `${refPrefix}/${branch}`
  // A branch moat created is already namespaced; do not double the prefix.
  const local = opts.name ?? (branch.startsWith("moat") ? branch : `moat/${branch}`)

  const exists = await run("git", ["-C", p.projectDir, "rev-parse", "--verify", "--quiet", ref], {
    env: SANITIZED_GIT_ENV,
    allowFailure: true,
  })
  if (exists.code !== 0) throw new Error(`nothing fetched at ${ref}. Run \`moat fetch ${branch}\` first.`)

  if (opts.checkout) {
    const status = await run("git", ["-C", p.projectDir, "status", "--porcelain"], { env: SANITIZED_GIT_ENV })
    if (status.stdout.trim().length > 0) {
      throw new Error(
        "refusing to check out: the host working tree has uncommitted changes. " +
          "Commit or stash them, or run `moat apply` without --checkout to only create the branch.",
      )
    }
    await run("git", ["-C", p.projectDir, "checkout", "-B", local, ref], { env: SANITIZED_GIT_ENV })
  } else {
    await run("git", ["-C", p.projectDir, "branch", "--force", local, ref], { env: SANITIZED_GIT_ENV })
  }
  return { branch: local, ref }
}
