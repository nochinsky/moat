import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { envPathsForId } from "../../lib/paths.ts"
import { recoverStateFromDisk } from "../../sandbox/recover.ts"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
}

/** A throwaway MOAT_HOME. The path helpers read the variable at call time. */
function withHome(t: { after: (fn: () => void) => void }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moat-recover-"))
  const previous = process.env.MOAT_HOME
  process.env.MOAT_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.MOAT_HOME
    else process.env.MOAT_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

const ID = "0123456789ab"

/**
 * An environment directory as a lost state.json leaves it: the rootfs is whole,
 * /work holds a branch with a commit the host has never seen, `refs/moat/baseline`
 * is still there, and the metadata file is gone.
 */
function lostStateEnv(home: string): { projectDir: string; work: string; baseline: string; agentHead: string } {
  const projectDir = path.join(home, "project")
  const work = path.join(home, "envs", ID, "rootfs", "work")
  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(work, { recursive: true })
  git(work, "init", "-q", "-b", "main")
  git(work, "config", "user.email", "agent@moat.invalid")
  git(work, "config", "user.name", "moat agent")
  fs.writeFileSync(path.join(work, "README.md"), "copied in\n")
  git(work, "add", "-A")
  git(work, "commit", "-qm", "baseline")
  const baseline = git(work, "rev-parse", "HEAD").trim()
  git(work, "update-ref", "refs/moat/baseline", baseline)
  git(work, "checkout", "-q", "-B", "moat-session-2026-01-01-00-00")
  fs.writeFileSync(path.join(work, "precious.txt"), "unrecoverable agent work\n")
  git(work, "add", "-A")
  git(work, "commit", "-qm", "agent: the work that matters")
  const agentHead = git(work, "rev-parse", "HEAD").trim()
  fs.mkdirSync(path.join(home, "envs", ID, "rootfs", "etc"), { recursive: true })
  fs.writeFileSync(path.join(home, "envs", ID, "rootfs", "etc", "alpine-release"), "3.21.4\n")
  return { projectDir, work, baseline, agentHead }
}

test("an environment whose state.json is gone is rebuilt from its rootfs", async (t) => {
  // The bug, measured: state.json was read as "no environment", so `moat up`
  // provisioned over the rootfs and destroyed a committed agent branch and an
  // untracked file without a word -- contradicting SPEC §2.2, which says moat
  // destroy is the only operation that deletes data.
  const home = withHome(t)
  const fixture = lostStateEnv(home)
  const state = await recoverStateFromDisk(envPathsForId(ID, fixture.projectDir))

  assert.equal(state.id, ID)
  assert.equal(state.projectDir, fixture.projectDir)
  assert.equal(state.status, "stopped")
  assert.equal(state.pid, null)
  assert.equal(state.branch, "moat-session-2026-01-01-00-00", "the branch the agent worked on")
  assert.equal(state.baselineCommit, fixture.baseline, "the copy-in baseline is in the sandbox repo")
  assert.equal(state.alpineVersion, "3.21.4", "read from the rootfs, not assumed")

  // What must NOT be invented: a credential that no longer exists, a host
  // baseline that was never recorded (the drift check has to know it cannot
  // run), and a version the rootfs does not state.
  assert.equal(state.credential, null)
  assert.equal(state.baselineHostState, null)

  // And the work itself is untouched by the reading.
  assert.equal(git(fixture.work, "rev-parse", "HEAD").trim(), fixture.agentHead)
  assert.equal(fs.readFileSync(path.join(fixture.work, "precious.txt"), "utf8"), "unrecoverable agent work\n")
})

test("a detached head is not reported as a branch", async (t) => {
  const home = withHome(t)
  const fixture = lostStateEnv(home)
  git(fixture.work, "checkout", "-q", "--detach", fixture.agentHead)

  const state = await recoverStateFromDisk(envPathsForId(ID, fixture.projectDir))
  assert.equal(state.branch, null)
  assert.equal(state.baselineCommit, fixture.baseline)
})

test("the rootfs version file is read through the guard, not through a symlink", async (t) => {
  const home = withHome(t)
  const fixture = lostStateEnv(home)
  const secret = path.join(home, "host-version")
  fs.writeFileSync(secret, "not from the rootfs\n")
  fs.rmSync(path.join(home, "envs", ID, "rootfs", "etc", "alpine-release"))
  fs.symlinkSync(secret, path.join(home, "envs", ID, "rootfs", "etc", "alpine-release"))

  const state = await recoverStateFromDisk(envPathsForId(ID, fixture.projectDir))
  assert.equal(state.alpineVersion, "unknown", "a symlinked version file must not be followed")
})
