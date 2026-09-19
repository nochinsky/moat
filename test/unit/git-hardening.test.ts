import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { safeConfigFor, sandboxGit } from "../../lib/git.ts"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
}

function makeRepo(): { root: string; repo: string; marker: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-hard-"))
  const repo = path.join(root, "repo")
  fs.mkdirSync(repo, { recursive: true })
  git(repo, "init", "-q")
  git(repo, "config", "user.email", "a@b")
  git(repo, "config", "user.name", "t")
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", "base")
  return { root, repo, marker: path.join(root, "PWNED") }
}

function plantScript(file: string, marker: string): void {
  fs.writeFileSync(file, "#!/bin/sh\necho ran >> " + marker + "\n")
  fs.chmodSync(file, 0o755)
}

test("a repo-configured fsmonitor does not run on the host", (t) => {
  const f = makeRepo()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  plantScript(path.join(f.repo, "evil.sh"), f.marker)
  git(f.repo, "config", "core.fsmonitor", "./evil.sh")

  // Control: plain git does execute it, so this test is capable of failing.
  execFileSync("git", ["-C", f.repo, "status", "--porcelain"])
  assert.ok(fs.existsSync(f.marker), "control: plain git should have executed the fsmonitor")
  fs.rmSync(f.marker, { force: true })

  return (async () => {
    const result = await sandboxGit(f.repo, ["status", "--porcelain"])
    assert.equal(result.code, 0)
    assert.equal(fs.existsSync(f.marker), false, "hardened git must not execute the fsmonitor")
    assert.equal(git(f.repo, "config", "core.fsmonitor").trim(), "./evil.sh", "the agent's config must be restored")
  })()
})

test("a pre-commit hook written in the sandbox does not run on the host", (t) => {
  const f = makeRepo()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const hooks = path.join(f.repo, ".git", "hooks")
  fs.mkdirSync(hooks, { recursive: true })
  plantScript(path.join(hooks, "pre-commit"), f.marker)

  // Control.
  fs.writeFileSync(path.join(f.repo, "b.txt"), "b\n")
  execFileSync("git", ["-C", f.repo, "add", "-A"])
  execFileSync("git", ["-C", f.repo, "commit", "-qm", "plain"])
  assert.ok(fs.existsSync(f.marker), "control: plain commit should have run the hook")
  fs.rmSync(f.marker, { force: true })

  return (async () => {
    fs.writeFileSync(path.join(f.repo, "c.txt"), "c\n")
    await sandboxGit(f.repo, ["add", "-A"])
    // The sanitized config drops user.* like everything else, so the identity is
    // passed explicitly — exactly as moat's own commit paths do.
    const commit = await sandboxGit(f.repo, ["commit", "--quiet", "-m", "hardened"], {
      allowFailure: true,
      env: {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "a@b",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "a@b",
      },
    })
    assert.equal(commit.code, 0)
    assert.equal(fs.existsSync(f.marker), false, "hardened git must not run the agent's hook")
  })()
})

test("a clean filter configured in the repo does not run on the host", (t) => {
  const f = makeRepo()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  plantScript(path.join(f.repo, "filter.sh"), f.marker)
  fs.writeFileSync(path.join(f.repo, ".gitattributes"), "*.txt filter=evil\n")
  git(f.repo, "config", "filter.evil.clean", "./filter.sh")

  return (async () => {
    fs.writeFileSync(path.join(f.repo, "a.txt"), "changed\n")
    const result = await sandboxGit(f.repo, ["status", "--porcelain"])
    assert.equal(result.code, 0)
    assert.equal(fs.existsSync(f.marker), false, "hardened git must not run the agent's filter")
  })()
})

test("sandboxGit refuses a .git file that points outside the workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-gitfile-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const elsewhere = path.join(root, "elsewhere")
  const work = path.join(root, "work")
  fs.mkdirSync(elsewhere, { recursive: true })
  fs.mkdirSync(work, { recursive: true })
  fs.writeFileSync(path.join(work, ".git"), "gitdir: " + elsewhere + "\n")
  return (async () => {
    await assert.rejects(() => sandboxGit(work, ["status"]), /refusing to run host git/)
  })()
})

test("the sanitized config keeps only the repository-format keys", (t) => {
  const f = makeRepo()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  git(f.repo, "config", "core.fsmonitor", "./evil.sh")
  git(f.repo, "config", "filter.evil.clean", "./evil.sh")
  git(f.repo, "config", "alias.status", "!echo pwned")
  const safe = safeConfigFor(path.join(f.repo, ".git"))
  assert.equal(safe.includes("fsmonitor"), false)
  assert.equal(safe.includes("filter"), false)
  assert.equal(safe.includes("alias"), false)
  assert.match(safe, /repositoryformatversion = 0/)
})
