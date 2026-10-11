import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { replaceRootfsDir } from "../../lib/rootfs-fs.ts"

function fixture(t: { after: (fn: () => void) => void }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moat-dir-install-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const rootfs = path.join(home, "rootfs")
  const parent = path.join(rootfs, "opt/moat")
  const prepared = path.join(home, "prepared")
  const outside = path.join(home, "outside")
  for (const dir of [path.join(parent, "pi"), prepared, outside]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(parent, "pi/version"), "old")
  fs.writeFileSync(path.join(prepared, "version"), "new")
  fs.writeFileSync(path.join(outside, "sentinel"), "untouched")
  return { rootfs, parent, prepared, outside }
}

test("a prepared runtime directory replaces the old tree, with no leftovers", (t) => {
  const { rootfs, parent, prepared } = fixture(t)
  replaceRootfsDir(rootfs, "/opt/moat/pi", prepared)
  assert.equal(fs.readFileSync(path.join(parent, "pi/version"), "utf8"), "new")
  assert.deepEqual(fs.readdirSync(parent), ["pi"])
})

test("a failed wrapper installation restores the previous runtime directory", (t) => {
  const { rootfs, parent, prepared } = fixture(t)
  assert.throws(() => replaceRootfsDir(rootfs, "/opt/moat/pi", prepared, () => { throw new Error("wrapper failed") }), /wrapper failed/)
  assert.equal(fs.readFileSync(path.join(parent, "pi/version"), "utf8"), "old")
  assert.deepEqual(fs.readdirSync(parent), ["pi"])
})

test("runtime directory installation refuses an existing symlinked parent", (t) => {
  const { rootfs, parent, prepared, outside } = fixture(t)
  fs.rmSync(parent, { recursive: true })
  fs.symlinkSync(outside, parent)
  assert.throws(() => replaceRootfsDir(rootfs, "/opt/moat/pi", prepared), /symlink/)
  assert.deepEqual(fs.readdirSync(outside), ["sentinel"])
})

test("a parent swapped after the guard opens cannot redirect a runtime install to the host", (t) => {
  const { rootfs, parent, prepared, outside } = fixture(t)
  const rename = fs.renameSync
  const held = parent + "-held"
  fs.renameSync = (source, destination) => {
    if (source === prepared) {
      rename(parent, held)
      fs.symlinkSync(outside, parent)
    }
    rename(source, destination)
  }
  try {
    replaceRootfsDir(rootfs, "/opt/moat/pi", prepared)
  } finally {
    fs.renameSync = rename
  }
  assert.deepEqual(fs.readdirSync(outside), ["sentinel"])
  assert.equal(fs.readFileSync(path.join(held, "pi/version"), "utf8"), "new")
})
