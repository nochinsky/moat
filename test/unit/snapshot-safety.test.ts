import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import type { EnvPaths } from "../../lib/paths.ts"
import { listSnapshots, restoreEnv, snapshotEnv, validateSnapshotName } from "../../sandbox/rootfs.ts"

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-snap-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, "env")
  const rootfs = path.join(dir, "rootfs")
  const snapshots = path.join(dir, "snapshots")
  fs.mkdirSync(path.join(rootfs, "work"), { recursive: true })
  fs.mkdirSync(snapshots, { recursive: true })
  fs.writeFileSync(path.join(rootfs, "old-marker.txt"), "old\n")
  fs.writeFileSync(path.join(rootfs, "work", "project.txt"), "project\n")
  const p = {
    id: "t",
    projectDir: root,
    dir,
    rootfs,
    work: path.join(rootfs, "work"),
    mountpoint: path.join(dir, "mnt"),
    state: "",
    logs: "",
    snapshots,
    entryScript: "",
    auditDir: "",
  } as EnvPaths
  return { dir, rootfs, snapshots, p }
}

/** A snapshot whose only content is a marker file named for the scenario. */
function makeSnapshot(snapshots: string, name: string, marker: string): void {
  const contents = fs.mkdtempSync(path.join(os.tmpdir(), "moat-snap-content-"))
  fs.writeFileSync(path.join(contents, marker), marker + "\n")
  execFileSync("tar", ["-czf", path.join(snapshots, name + ".tar.gz"), "-C", contents, "."])
  fs.rmSync(contents, { recursive: true, force: true })
}

test("snapshot names cannot leave the snapshot directory", () => {
  for (const name of ["baseline", "before-extras", "a.b-c_d1", "A1"]) {
    assert.equal(validateSnapshotName(name), name)
  }
  for (const bad of ["../evil", "a/b", "", ".hidden", "with space", "x".repeat(65)]) {
    assert.throws(() => validateSnapshotName(bad), /invalid snapshot name/)
  }
})

test("snapshotEnv refuses an invalid name and writes no file", (t) => {
  const f = fixture(t)
  return (async () => {
    await assert.rejects(() => snapshotEnv(f.p, "../evil"), /invalid snapshot name/)
    assert.deepEqual(fs.readdirSync(f.snapshots), [])
  })()
})

test("listSnapshots ignores a file whose name is not valid", (t) => {
  const f = fixture(t)
  makeSnapshot(f.snapshots, "good", "good")
  fs.writeFileSync(path.join(f.snapshots, "..evil.tar.gz"), "x")
  return (async () => {
    assert.deepEqual((await listSnapshots(f.p)).map((s) => s.name), ["good"])
  })()
})

test("restore replaces the rootfs and preserves the project copy", (t) => {
  const f = fixture(t)
  makeSnapshot(f.snapshots, "new", "new-marker.txt")
  return (async () => {
    await restoreEnv(f.p, "new")
    assert.equal(fs.existsSync(path.join(f.rootfs, "new-marker.txt")), true)
    assert.equal(fs.existsSync(path.join(f.rootfs, "old-marker.txt")), false)
    assert.equal(fs.readFileSync(path.join(f.rootfs, "work", "project.txt"), "utf8"), "project\n")
    assert.equal(fs.existsSync(path.join(f.dir, "rootfs.restore-" + process.pid)), false, "no staging left")
  })()
})

test("a failed restore leaves the rootfs and the project untouched", (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.snapshots, "broken.tar.gz"), "not a tar archive")
  return (async () => {
    await assert.rejects(() => restoreEnv(f.p, "broken"))
    assert.equal(fs.readFileSync(path.join(f.rootfs, "old-marker.txt"), "utf8"), "old\n")
    assert.equal(fs.readFileSync(path.join(f.rootfs, "work", "project.txt"), "utf8"), "project\n")
    assert.equal(fs.existsSync(path.join(f.dir, "rootfs.restore-" + process.pid)), false, "no staging left")
  })()
})
