import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import type { EnvPaths } from "../../lib/paths.ts"
import { snapshotEnv } from "../../sandbox/rootfs.ts"

const REPO = fileURLToPath(new URL("../..", import.meta.url))

/** Run a child that writes one state file n times, as a racing moat command does. */
function writer(script: string, dir: string, id: string, iterations: number): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, dir, id, String(iterations)], { stdio: "ignore" })
    child.on("close", (code) => resolve(code ?? -1))
  })
}

test("two processes writing one state file both succeed", async (t) => {
  // The bug, measured: writeState used a fixed state.json.tmp, so an "up" racing
  // an "exec"/doctor shared it. Three runs out of three, one of the two writers
  // died with ENOENT on the rename — an unhandled crash after its work was done,
  // and its update was lost.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moat-state-race-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const script = path.join(dir, "writer.mjs")
  fs.writeFileSync(
    script,
    [
      `import { writeState } from ${JSON.stringify(path.join(REPO, "sandbox/state.ts"))}`,
      "const [dir, id, n] = process.argv.slice(2)",
      "const paths = { state: dir + '/state.json' }",
      "for (let i = 0; i < Number(n); i++) writeState(paths, { version: 1, id, i })",
    ].join("\n"),
  )

  const [a, b] = await Promise.all([writer(script, dir, "a", 4000), writer(script, dir, "b", 4000)])
  assert.equal(a, 0)
  assert.equal(b, 0)
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as { id: string; i: number }
  assert.ok(state.id === "a" || state.id === "b")
  assert.equal(typeof state.i, "number")
  // The unique temp names are renamed away, not left behind.
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".part-")), [])
})

test("two snapshots of the same name at once both finish", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moat-snap-race-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const rootfs = path.join(dir, "rootfs")
  const snapshots = path.join(dir, "snapshots")
  fs.mkdirSync(path.join(rootfs, "work"), { recursive: true })
  fs.mkdirSync(snapshots, { recursive: true })
  // Enough content that the two tars overlap.
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(path.join(rootfs, `file-${i}.txt`), "x".repeat(64 * 1024))
  }
  const p = { rootfs, snapshots } as EnvPaths

  const results = await Promise.allSettled([snapshotEnv(p, "twice"), snapshotEnv(p, "twice")])
  const rejected = results.filter((r) => r.status === "rejected")
  assert.deepEqual(
    rejected.map((r) => String((r as PromiseRejectedResult).reason)),
    [],
  )
  const file = path.join(snapshots, "twice.tar.gz")
  assert.equal(fs.existsSync(file), true)
  assert.ok(fs.statSync(file).size > 0)
  assert.deepEqual(fs.readdirSync(snapshots).filter((name) => name.includes(".part-")), [])
})
