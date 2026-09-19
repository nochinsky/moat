import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { envPaths } from "../../lib/paths.ts"
import { copyIn, hostState } from "../../sync/copyin.ts"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
}

/** "caf" + one non-UTF-8 byte + " more", the shape that broke the string pipeline. */
function latin(byte: number): Buffer {
  return Buffer.from([0x63, 0x61, 0x66, byte, 0x20, 0x6d, 0x6f, 0x72, 0x65, 0x0a])
}

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-copyin-"))
  const previousHome = process.env.MOAT_HOME
  process.env.MOAT_HOME = path.join(root, "moat-home")
  t.after(() => {
    if (previousHome === undefined) delete process.env.MOAT_HOME
    else process.env.MOAT_HOME = previousHome
    fs.rmSync(root, { recursive: true, force: true })
  })
  const host = path.join(root, "project")
  fs.mkdirSync(host, { recursive: true })
  git(host, "init", "-q")
  git(host, "config", "user.email", "a@b")
  git(host, "config", "user.name", "t")
  fs.writeFileSync(path.join(host, "latin.txt"), "caf\n")
  git(host, "add", "-A")
  git(host, "commit", "-qm", "base")
  return { root, host, p: envPaths(host) }
}

test("copy-in reproduces a modified non-UTF-8 text file byte for byte", (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.host, "latin.txt"), latin(0xe9))

  // Control: the old pipeline captured the diff as a UTF-8 string and wrote that
  // back. The replacement character re-encodes to three bytes, so the patch no
  // longer applies and the clone keeps the stale committed content.
  const lossy = execFileSync("git", ["-C", f.host, "diff", "--binary", "HEAD"], { encoding: "utf8" })
  const scratch = path.join(f.root, "old-clone")
  execFileSync("git", ["clone", "-q", f.host, scratch])
  const patch = path.join(f.root, "old.patch")
  fs.writeFileSync(patch, lossy)
  spawnSync("git", ["-C", scratch, "apply", patch])
  // Whether apply refuses the mangled patch or "succeeds" by writing the
  // replacement bytes, the clone cannot match the host. That is the failure the
  // file-based pipeline removes.
  assert.notDeepEqual(
    fs.readFileSync(path.join(scratch, "latin.txt")),
    latin(0xe9),
    "control: the lossy string pipeline cannot reproduce the host bytes",
  )

  return (async () => {
    await copyIn(f.p)
    assert.deepEqual(fs.readFileSync(path.join(f.p.work, "latin.txt")), latin(0xe9))
  })()
})

test("drift detection is sensitive to a byte-only change", (t) => {
  const f = fixture(t)

  // Note, for honesty: this one is a guard, not an old-behaviour regression.
  // The old fingerprint hashed the diff string, but the string includes git's
  // "index <old>..<new>" line, whose blob hash is computed over raw bytes — so
  // it did notice a byte change. Hashing raw bytes keeps that property without
  // depending on git's text escaping, and this pins it down.
  return (async () => {
    fs.writeFileSync(path.join(f.host, "latin.txt"), latin(0xe9))
    const before = await hostState(f.host)
    fs.writeFileSync(path.join(f.host, "latin.txt"), latin(0xff))
    const after = await hostState(f.host)
    assert.notEqual(before, after, "a byte-only change must register as drift")
  })()
})
