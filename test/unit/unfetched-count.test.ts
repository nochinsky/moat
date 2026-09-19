import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { envPaths } from "../../lib/paths.ts"
import { countUnfetched } from "../../sync/copyout.ts"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
}

function commit(cwd: string, message: string): void {
  git(cwd, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "-m", message)
}

/** A host repository, and a sandbox clone of it on the agent branch. */
function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-unfetched-"))
  const previousHome = process.env.MOAT_HOME
  process.env.MOAT_HOME = path.join(root, "moat-home")
  t.after(() => {
    if (previousHome === undefined) delete process.env.MOAT_HOME
    else process.env.MOAT_HOME = previousHome
    fs.rmSync(root, { recursive: true, force: true })
  })
  const host = path.join(root, "project")
  fs.mkdirSync(host, { recursive: true })
  git(host, "init", "-q", "-b", "main")
  git(host, "config", "user.email", "a@b")
  git(host, "config", "user.name", "t")
  fs.writeFileSync(path.join(host, "base.txt"), "base\n")
  git(host, "add", "-A")
  commit(host, "base")
  const p = envPaths(host)
  fs.mkdirSync(path.dirname(p.work), { recursive: true })
  execFileSync("git", ["clone", "-q", host, p.work])
  git(p.work, "config", "user.email", "a@b")
  git(p.work, "config", "user.name", "t")
  git(p.work, "checkout", "-q", "-b", "moat-session-test")
  return { root, host, p }
}

test("a commit on a side branch counts, even though HEAD does not have it", (t) => {
  // Measured before this fix: the drift check re-copied the project because this
  // returned 0, and the branch, the commit and the file were gone.
  const f = fixture(t)
  return (async () => {
    git(f.p.work, "checkout", "-q", "-b", "experiment")
    fs.writeFileSync(path.join(f.p.work, "important.txt"), "important work\n")
    git(f.p.work, "add", "-A")
    commit(f.p.work, "work on a side branch")
    git(f.p.work, "checkout", "-q", "moat-session-test")
    assert.equal(git(f.p.work, "status", "--porcelain").trim(), "", "the worktree is clean")
    assert.equal(await countUnfetched(f.p), 1)
  })()
})

test("the same commit stops counting once the host has it under refs/moat", (t) => {
  const f = fixture(t)
  return (async () => {
    git(f.p.work, "checkout", "-q", "-b", "experiment")
    fs.writeFileSync(path.join(f.p.work, "important.txt"), "important work\n")
    git(f.p.work, "add", "-A")
    commit(f.p.work, "work on a side branch")
    git(f.p.work, "checkout", "-q", "moat-session-test")
    // Exactly what `moat fetch experiment` does to the host repository.
    git(f.host, "fetch", "-q", "--no-tags", f.p.work, "+refs/heads/experiment:refs/moat/experiment")
    assert.equal(await countUnfetched(f.p), 0, "fetched work is on the host, so a re-copy is lossless")
  })()
})

test("an unfetched commit on HEAD counts, and a clean sandbox counts zero", (t) => {
  const f = fixture(t)
  return (async () => {
    assert.equal(await countUnfetched(f.p), 0, "right after the copy-in there is nothing to lose")
    fs.writeFileSync(path.join(f.p.work, "note.txt"), "note\n")
    git(f.p.work, "add", "-A")
    commit(f.p.work, "a commit on the session branch")
    assert.equal(await countUnfetched(f.p), 1)
  })()
})

test("two branches with one commit each count two, not one", (t) => {
  const f = fixture(t)
  return (async () => {
    fs.writeFileSync(path.join(f.p.work, "a.txt"), "a\n")
    git(f.p.work, "add", "-A")
    commit(f.p.work, "on the session branch")
    git(f.p.work, "checkout", "-q", "-b", "experiment")
    fs.writeFileSync(path.join(f.p.work, "b.txt"), "b\n")
    git(f.p.work, "add", "-A")
    commit(f.p.work, "on the side branch")
    git(f.p.work, "checkout", "-q", "moat-session-test")
    assert.equal(await countUnfetched(f.p), 2)
  })()
})

test("a host that is not a git repository loses the comparison, not the commits", (t) => {
  // A plain directory is a supported project: moat gives the sandbox its own
  // repository. There are no host refs to compare against, so every commit the
  // agent added has to count; returning 0 here is the same false "nothing to lose".
  const f = fixture(t)
  return (async () => {
    fs.writeFileSync(path.join(f.p.work, "agent.txt"), "agent work\n")
    git(f.p.work, "add", "-A")
    commit(f.p.work, "agent work")
    git(f.p.work, "update-ref", "refs/moat/baseline", "HEAD~1")
    // The host becomes a plain directory: no repository at all.
    fs.rmSync(path.join(f.host, ".git"), { recursive: true, force: true })
    assert.equal(await countUnfetched(f.p), 1)
    git(f.p.work, "reset", "-q", "--hard", "refs/moat/baseline")
    assert.equal(await countUnfetched(f.p), 0, "the baseline itself is not agent work")
  })()
})

test("a detached host HEAD still counts as a place the work can be", (t) => {
  // `rev-list --all` includes a detached HEAD (measured), so a fetched tip that the
  // host has checked out detached must not read as unfetched work.
  const f = fixture(t)
  return (async () => {
    git(f.p.work, "checkout", "-q", "-b", "experiment")
    fs.writeFileSync(path.join(f.p.work, "x.txt"), "x\n")
    git(f.p.work, "add", "-A")
    commit(f.p.work, "work")
    git(f.p.work, "checkout", "-q", "moat-session-test")
    git(f.host, "fetch", "-q", "--no-tags", f.p.work, "+refs/heads/experiment:refs/moat/experiment")
    const tip = git(f.p.work, "rev-parse", "experiment").trim()
    git(f.host, "checkout", "-q", "--detach", tip)
    assert.equal(await countUnfetched(f.p), 0, "the host has it, detached or not")
    git(f.p.work, "checkout", "-q", "experiment")
    fs.writeFileSync(path.join(f.p.work, "y.txt"), "y\n")
    git(f.p.work, "add", "-A")
    commit(f.p.work, "more work")
    git(f.p.work, "checkout", "-q", "moat-session-test")
    assert.equal(await countUnfetched(f.p), 1, "and new work is still new")
  })()
})

test("a tag that keeps a commit alive is counted too", (t) => {
  const f = fixture(t)
  return (async () => {
    fs.writeFileSync(path.join(f.p.work, "tagged.txt"), "tagged\n")
    git(f.p.work, "add", "-A")
    commit(f.p.work, "work kept by a tag")
    git(f.p.work, "tag", "release-1")
    git(f.p.work, "reset", "-q", "--hard", "HEAD~1")
    assert.equal(await countUnfetched(f.p), 1, "fetch --no-tags never brings the tag across")
  })()
})
