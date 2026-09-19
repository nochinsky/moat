import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { hashTree } from "../../lib/hash.ts"

/**
 * The straightforward whole-file implementation, kept here as the reference the
 * streaming one has to match byte for byte: digests from before the change are
 * quoted in evidence and compared across runs, so the format cannot drift.
 */
function reference(root: string, skip = [".git"]): { digest: string; files: number; bytes: number } {
  const hash = crypto.createHash("sha256")
  let files = 0
  let bytes = 0
  const walk = (dir: string, rel: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name
      if (rel === "" && skip.includes(entry.name)) continue
      const abs = path.join(dir, entry.name)
      const stat = fs.lstatSync(abs)
      if (stat.isSymbolicLink()) {
        hash.update(`L ${entryRel} ${fs.readlinkSync(abs)}\n`)
        continue
      }
      if (stat.isDirectory()) {
        hash.update(`D ${entryRel}\n`)
        walk(abs, entryRel)
        continue
      }
      if (!stat.isFile()) {
        hash.update(`O ${entryRel} ${stat.mode & 0o7777}\n`)
        continue
      }
      const content = fs.readFileSync(abs)
      hash.update(`F ${entryRel} ${stat.mode & 0o7777} ${content.length} `)
      hash.update(content)
      hash.update("\n")
      files += 1
      bytes += content.length
    }
  }
  walk(root, "")
  return { digest: hash.digest("hex"), files, bytes }
}

test("the streamed tree hash matches the whole-file hash, chunk boundaries included", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-hash-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const mib = 1024 * 1024
  fs.writeFileSync(path.join(root, "empty.bin"), Buffer.alloc(0))
  fs.writeFileSync(path.join(root, "small.txt"), "hello\n")
  fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 255, 128, 1, 2, 0, 10]))
  fs.writeFileSync(path.join(root, "exact-mib.bin"), Buffer.alloc(mib, 7))
  fs.writeFileSync(path.join(root, "over-mib.bin"), Buffer.alloc(mib + 1, 3))
  fs.writeFileSync(path.join(root, "two-and-a-half.bin"), Buffer.alloc(2.5 * mib, 9))
  fs.writeFileSync(path.join(root, "exec.sh"), "#!/bin/sh\n")
  fs.chmodSync(path.join(root, "exec.sh"), 0o755)
  fs.symlinkSync("small.txt", path.join(root, "link.txt"))
  fs.mkdirSync(path.join(root, "nested", "deeper"), { recursive: true })
  fs.writeFileSync(path.join(root, "nested", "one.txt"), "one")
  fs.writeFileSync(path.join(root, "nested", "deeper", "two.bin"), Buffer.alloc(3 * mib + 17, 5))
  fs.mkdirSync(path.join(root, ".git"))
  fs.writeFileSync(path.join(root, ".git", "index"), "skipped")

  assert.deepEqual(hashTree(root), reference(root))
  // Skipping is opt-out, and the option still reaches the walk.
  assert.deepEqual(hashTree(root, { skip: [] }), reference(root, []))
})

test("a file the walk cannot finish reading does not poison the count", (t) => {
  // A concurrent writer is the realistic case in the sandbox: the header carries
  // the size from lstat, so the digest stays well defined even if the file shrinks
  // under the read.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-hash-short-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, "shrinking.bin"), Buffer.alloc(64 * 1024, 1))
  const result = hashTree(root)
  assert.equal(result.files, 1)
  assert.equal(result.bytes, 64 * 1024)
  assert.equal(result.digest.length, 64)
})
