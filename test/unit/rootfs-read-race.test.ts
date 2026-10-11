import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { readRootfsFile, readRootfsFileHead, readRootfsFileTail } from "../../lib/rootfs-fs.ts"

const readers = {
  full: (root: string) => readRootfsFile(root, "/etc/data", { maxBytes: 1024 }),
  head: (root: string) => readRootfsFileHead(root, "/etc/data", 1024),
  tail: (root: string) => readRootfsFileTail(root, "/etc/data", 1024),
}
for (const [name, read] of Object.entries(readers)) test(`${name} reader refuses a parent swapped after walking the rootfs`, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moat-read-race-"))
  const root = path.join(home, "rootfs"), parent = path.join(root, "etc"), outside = path.join(home, "outside")
  fs.mkdirSync(parent, { recursive: true }); fs.mkdirSync(outside)
  fs.writeFileSync(path.join(parent, "data"), "box-data")
  fs.writeFileSync(path.join(outside, "data"), "host-only-secret")
  const open = fs.openSync
  let swapped = false
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (!swapped && String(args[0]) === path.join(parent, "data")) {
      swapped = true
      fs.renameSync(parent, `${parent}.old`)
      fs.symlinkSync(outside, parent)
    }
    return open(...args)
  })
  try {
    assert.equal(read(root), null)
    assert.equal(swapped, true)
    assert.equal(fs.readFileSync(path.join(outside, "data"), "utf8"), "host-only-secret")
  } finally { fs.openSync = open; fs.rmSync(home, { recursive: true, force: true }) }
})

test("rootfs readers refuse a FIFO without blocking the host", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-read-fifo-"))
  try {
    fs.mkdirSync(path.join(root, "etc"))
    assert.equal(spawnSync("mkfifo", [path.join(root, "etc/data")]).status, 0)
    for (const read of Object.values(readers)) assert.equal(read(root), null)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("a capped full read refuses growth after fstat instead of pulling the enlarged file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-read-growth-"))
  const target = path.join(root, "etc/data")
  fs.mkdirSync(path.dirname(target)); fs.writeFileSync(target, "tiny")
  const stat = fs.fstatSync
  let grew = false
  fs.fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => {
    const result = stat(...args)
    if (!grew) { grew = true; fs.appendFileSync(target, "x".repeat(2048)) }
    return result
  }) as typeof fs.fstatSync
  try { assert.equal(readRootfsFile(root, "/etc/data", { maxBytes: 1024 }), null); assert.equal(grew, true) }
  finally { fs.fstatSync = stat; fs.rmSync(root, { recursive: true, force: true }) }
})
