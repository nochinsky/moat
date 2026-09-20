import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { envPaths } from "../../lib/paths.ts"
import { copyIn } from "../../sync/copyin.ts"
import { fetchBranch } from "../../sync/copyout.ts"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
}

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-report-"))
  const previousHome = process.env.MOAT_HOME
  process.env.MOAT_HOME = path.join(root, "moat-home")
  t.after(() => {
    if (previousHome === undefined) delete process.env.MOAT_HOME
    else process.env.MOAT_HOME = previousHome
    fs.rmSync(root, { recursive: true, force: true })
  })
  const host = path.join(root, "project")
  fs.mkdirSync(path.join(host, "ignored"), { recursive: true })
  fs.writeFileSync(path.join(host, ".gitignore"), "ignored/\n")
  fs.writeFileSync(path.join(host, "tracked.txt"), "tracked\n")
  git(host, "init", "-q")
  git(host, "config", "user.email", "a@b")
  git(host, "config", "user.name", "t")
  git(host, "add", "-A")
  git(host, "commit", "-qm", "base")
  return { root, host, p: envPaths(host) }
}

test("copy-in names the paths git cannot carry, and stays quiet about ignored ones", (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.host, "normal.txt"), "normal\n")
  fs.mkdirSync(path.join(f.host, "empty-dir"))
  const fifo = spawnSync("mkfifo", [path.join(f.host, "pipe")])
  return (async () => {
    const result = await copyIn(f.p)
    assert.ok(fs.existsSync(path.join(f.p.work, "normal.txt")), "a normal untracked file is copied")
    assert.ok(
      result.skippedFromCopy.some((item) => item.includes("empty-dir") && item.includes("empty directory")),
      JSON.stringify(result.skippedFromCopy),
    )
    // `if (mkfifo ok)` made this assertion optional, so on a host without mkfifo the
    // test silently stopped covering FIFOs — which is the case it exists for.
    assert.equal(fifo.status, 0, "the fixture needs mkfifo to create the FIFO: " + String(fifo.error ?? fifo.stderr))
    assert.ok(
      result.skippedFromCopy.some((item) => item.includes("pipe")),
      JSON.stringify(result.skippedFromCopy),
    )
    assert.equal(
      result.skippedFromCopy.some((item) => item.includes("ignored")),
      false,
      "an ignored path is deliberately not copied, so it is not reported as skipped",
    )
  })()
})

test("fetchBranch points a non-git project at moat apply", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-nongit-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const projectDir = path.join(root, "plain")
  fs.mkdirSync(projectDir)
  const p = { projectDir, work: path.join(root, "work") } as never
  return (async () => {
    await assert.rejects(() => fetchBranch(p, "main"), /moat apply still works/)
  })()
})
