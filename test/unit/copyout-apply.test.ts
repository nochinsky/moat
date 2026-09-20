import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import type { EnvPaths } from "../../lib/paths.ts"
import { applyBranch, suggestBranch } from "../../sync/copyout.ts"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
}

function hostRepo(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-copyout-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const host = path.join(root, "host")
  fs.mkdirSync(host)
  git(host, "init", "-q")
  git(host, "config", "user.email", "a@b")
  git(host, "config", "user.name", "t")
  fs.writeFileSync(path.join(host, "a.txt"), "one\n")
  git(host, "add", "-A")
  git(host, "commit", "-qm", "one")
  return { root, host }
}

/** Put a second commit on refs/moat/agent and return the host to commit "one". */
function withFetchedRef(host: string): string {
  fs.writeFileSync(path.join(host, "b.txt"), "two\n")
  git(host, "add", "-A")
  git(host, "commit", "-qm", "two")
  const tip = git(host, "rev-parse", "HEAD").trim()
  git(host, "reset", "-q", "--hard", "HEAD~1")
  git(host, "update-ref", "refs/moat/agent", tip)
  return tip
}

test("applyBranch creates the local branch without moving HEAD", (t) => {
  const { host } = hostRepo(t)
  const tip = withFetchedRef(host)
  const headBefore = git(host, "rev-parse", "HEAD").trim()
  const p = { projectDir: host } as EnvPaths
  return (async () => {
    const result = await applyBranch(p, "agent", { name: "from-agent" })
    assert.equal(result.branch, "from-agent")
    assert.equal(result.ref, "refs/moat/agent")
    assert.equal(git(host, "rev-parse", "from-agent").trim(), tip)
    assert.equal(git(host, "rev-parse", "HEAD").trim(), headBefore)
  })()
})

test("applyBranch checkout switches to it, and refuses a dirty tree", (t) => {
  const { host } = hostRepo(t)
  const tip = withFetchedRef(host)
  const p = { projectDir: host } as EnvPaths
  return (async () => {
    fs.writeFileSync(path.join(host, "a.txt"), "dirty\n")
    await assert.rejects(() => applyBranch(p, "agent", { checkout: true, name: "co" }), /uncommitted changes/)
    git(host, "checkout", "-q", "--", "a.txt")
    await applyBranch(p, "agent", { checkout: true, name: "co" })
    assert.equal(git(host, "rev-parse", "HEAD").trim(), tip)
  })()
})

test("applyBranch refuses a ref that was never fetched", (t) => {
  const { host } = hostRepo(t)
  const p = { projectDir: host } as EnvPaths
  return (async () => {
    await assert.rejects(() => applyBranch(p, "missing"), /nothing fetched/)
  })()
})

test("applyBranch never moves a branch that already exists and points elsewhere", (t) => {
  // `git branch --force <name> <ref>` and `git checkout -B <name> <ref>` both reset an
  // existing branch in silence, and this is the command where the user decides what the
  // agent's work becomes — it is not allowed to discard work that was already theirs.
  // Reintroducing `--force` here makes this test fail, which is the point of it.
  //
  // Every assertion below reads a fully-qualified refname, because `refs/moat/agent` and
  // `refs/heads/moat/agent` both exist here and the short name is ambiguous: git warns and
  // picks one, which is exactly how a test can pass while looking at the wrong object.
  const { host } = hostRepo(t)
  withFetchedRef(host)
  const mine = git(host, "rev-parse", "HEAD").trim()
  git(host, "branch", "moat/agent") // the user already has a branch by that name
  const head = "refs/heads/moat/agent"
  const p = { projectDir: host } as EnvPaths
  return (async () => {
    await assert.rejects(() => applyBranch(p, "agent"), /refusing to move the existing branch moat\/agent/)
    assert.equal(git(host, "rev-parse", head).trim(), mine, "their branch is where it was")
    // --checkout has the same shape and the same refusal.
    await assert.rejects(() => applyBranch(p, "agent", { checkout: true }), /refusing to move the existing branch/)
    assert.equal(git(host, "rev-parse", head).trim(), mine)
    // The way through is a different name, and it still works.
    const result = await applyBranch(p, "agent", { name: "their-branch" })
    assert.equal(result.branch, "their-branch")
    assert.equal(git(host, "rev-parse", "refs/heads/their-branch").trim(), git(host, "rev-parse", "refs/moat/agent").trim())
    assert.equal(git(host, "rev-parse", head).trim(), mine, "and the name they had is untouched")
  })()
})

test("applyBranch is a no-op on a branch already at the fetched ref", (t) => {
  // A second apply of the same fetch is not a conflict: there is nothing to move, so
  // refusing it would make the command un-rerunnable for no gain.
  const { host } = hostRepo(t)
  const tip = withFetchedRef(host)
  git(host, "branch", "moat/agent", "refs/moat/agent")
  const p = { projectDir: host } as EnvPaths
  return (async () => {
    const result = await applyBranch(p, "agent")
    assert.equal(result.branch, "moat/agent")
    assert.equal(git(host, "rev-parse", "refs/heads/moat/agent").trim(), tip)
    // And --checkout onto a branch already at the ref is allowed: it moves HEAD, not the branch.
    await applyBranch(p, "agent", { checkout: true })
    assert.equal(git(host, "rev-parse", "HEAD").trim(), tip)
  })()
})

test("suggestBranch prefers a branch whose tip the host cannot reach", (t) => {
  const { root, host } = hostRepo(t)
  const work = path.join(root, "work")
  fs.mkdirSync(work)
  git(work, "init", "-q")
  git(work, "config", "user.email", "a@b")
  git(work, "config", "user.name", "t")
  fs.writeFileSync(path.join(work, "agent.txt"), "agent work\n")
  git(work, "add", "-A")
  git(work, "commit", "-qm", "agent")
  git(work, "checkout", "-q", "-b", "moat-session-x")
  const p = { projectDir: host, work } as EnvPaths
  return (async () => {
    assert.equal(await suggestBranch(p), "moat-session-x")
  })()
})
