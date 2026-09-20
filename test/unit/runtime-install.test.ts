import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import type { EnvPaths } from "../../lib/paths.ts"
import { installRuntimeBinary } from "../../sandbox/rootfs.ts"

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-runtime-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, "env")
  const rootfs = path.join(dir, "rootfs")
  fs.mkdirSync(path.join(rootfs, "work"), { recursive: true })
  fs.mkdirSync(path.join(rootfs, "usr/local"), { recursive: true })
  const p = {
    id: "t",
    projectDir: root,
    dir,
    rootfs,
    work: path.join(rootfs, "work"),
    mountpoint: path.join(dir, "mnt"),
    state: path.join(dir, "state.json"),
    logs: path.join(dir, "logs"),
    snapshots: path.join(dir, "snapshots"),
    runtime: path.join(dir, "runtime"),
  } as unknown as EnvPaths
  return { root, rootfs, p }
}

test("a runtime install refuses a symlinked component instead of writing through it", async (t) => {
  // The rootfs is agent-writable and the agent is root inside it, so /usr/local/bin can be a
  // symlink to a host path. The destination guard has to run before anything is copied or
  // downloaded: this is the one host-side write that puts a 195–269 MB binary there.
  const { root, rootfs, p } = fixture(t)
  const outside = path.join(root, "outside")
  fs.mkdirSync(outside, { recursive: true })
  fs.symlinkSync(outside, path.join(rootfs, "usr/local/bin"))
  await assert.rejects(() => installRuntimeBinary(p, "codex"))
  assert.deepEqual(fs.readdirSync(outside), [], "nothing may be written through the planted symlink")
})
