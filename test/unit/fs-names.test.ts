import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { assertAddressableNames } from "../../lib/fs-names.ts"
import { hashTree } from "../../lib/hash.ts"

/** A byte that cannot appear in a UTF-8 sequence. */
const BAD = Buffer.from([0x62, 0x61, 0x64, 0xff, 0x6e, 0x61, 0x6d, 0x65]) // bad\xffname

test("a file name that is not valid UTF-8 is refused with the bytes that are wrong", (t) => {
  // The bug, measured: readdir decodes the raw 0xff as U+FFFD, so the name Node
  // builds is not the name on disk and hashTree threw ENOENT for a file that was
  // right there. Refusing early with the bytes is the honest version until Buffer
  // paths exist through every host-side walk.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-names-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, "normal.txt"), "fine\n")
  const raw = Buffer.concat([Buffer.from(root + "/"), BAD])
  fs.writeFileSync(raw, "not fine\n")

  assert.throws(() => assertAddressableNames(root), /not a valid UTF-8 file name.*ff/s)
  assert.throws(() => hashTree(root), /not a valid UTF-8 file name/)
})

test("valid UTF-8 names in any language are accepted", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-names-ok-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "café", "日本語"), { recursive: true })
  fs.writeFileSync(path.join(root, "café", "日本語", "💥.txt"), "x")
  fs.writeFileSync(path.join(root, "plain.txt"), "x")
  assert.doesNotThrow(() => assertAddressableNames(root))
  assert.equal(hashTree(root).files, 2)
  // A symlink to a bad name is not followed and does not throw.
  fs.symlinkSync(BAD, path.join(root, "link"))
  assert.doesNotThrow(() => assertAddressableNames(root))
})
