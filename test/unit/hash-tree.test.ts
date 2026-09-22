import assert from "node:assert/strict"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
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

/**
 * Wait until a file stops changing: two identical (size, mtime) readings a short interval apart.
 *
 * A killed writer is not necessarily a finished one — the shell dies, a `truncate` it had already
 * spawned does not — so the caller observes quiet rather than assuming it. Bounded, so a file that
 * never settles fails the test rather than hanging it.
 */
async function quiet(file: string, intervalMs = 60, tries = 50): Promise<void> {
  let previous = ""
  for (let attempt = 0; attempt < tries; attempt++) {
    const stat = fs.statSync(file)
    const reading = `${stat.size}:${stat.mtimeMs}`
    if (reading === previous) return
    previous = reading
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`${file} never stopped changing`)
}

test("a well-defined digest and count, for a file being rewritten under the read", async (t) => {
  // The old name promised a scenario the test never created: it hashed a file nobody
  // was writing to. The real case is a concurrent writer in the sandbox, where the
  // header carries the size from `lstat` and fewer bytes can come back than it
  // promised.
  //
  // What is asserted is the shape of the answer under a live writer — one file, a real
  // digest, a byte count equal to the size the header recorded — and not a particular
  // interleaving. Whether any given pass catches the file mid-shrink is a race the
  // test does not try to win: a test that fails when the machine is fast is worse than
  // one that states its weaker guarantee, and the stronger claim (the read loop stops
  // at EOF instead of spinning) is guarded by that loop's own `read <= 0` break.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-hash-short-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, "shrinking.bin")
  const size = 8 * 1024 * 1024
  fs.writeFileSync(file, Buffer.alloc(size, 1))
  // A shell loop, so there is no argument-plumbing of its own to get wrong: the two
  // sizes are interpolated into the script that runs.
  const writer = spawn(
    "sh",
    ["-c", `end=$(( $(date +%s) + 3 )); while [ "$(date +%s)" -lt "$end" ]; do truncate -s ${size} '${file}'; truncate -s 1024 '${file}'; done`],
    { stdio: "ignore" },
  )
  t.after(() => writer.kill("SIGKILL"))
  // Wait for the writer to be demonstrably running before measuring anything: without
  // this the test could pass vacuously if the writer never started.
  const started = Date.now()
  while (Date.now() - started < 3000) {
    if (fs.statSync(file).size !== size) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.notEqual(fs.statSync(file).size, size, "the writer must be shrinking the file before this test means anything")

  // Hash repeatedly while the writer runs. Every pass must come back with a real
  // digest: the header carries the size from lstat, and the read loop has to stop at
  // EOF rather than throw or spin when fewer bytes come back than it promised.
  const sizes: number[] = []
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = hashTree(root)
    assert.equal(result.files, 1, "one file, however many bytes came back")
    assert.equal(result.digest.length, 64, "the digest is always a real digest")
    assert.ok(result.bytes > 0 && result.bytes <= size, `a reported size must be a real one: ${result.bytes}`)
    sizes.push(result.bytes)
  }
  writer.kill("SIGKILL")
  // `kill` reaps the shell, not a `truncate` it had already spawned: that is a separate process and
  // can still land after the kill returns. So "the writer is gone" has to be observed, not assumed —
  // wait until the file stops changing before measuring it, or the two passes below can straddle one
  // last truncate. This failed on CI and passed locally, which is exactly how a timing assumption
  // hides: the runner's interleaving differed, not the code under test.
  await quiet(file)
  // With the writer gone, every pass reports the same size: the answer is a function
  // of the file, not of when the read happened to run.
  const after = hashTree(root)
  assert.equal(after.bytes, fs.statSync(file).size)
  assert.equal(hashTree(root).digest, after.digest, "a quiet file hashes to one digest")
})
