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
