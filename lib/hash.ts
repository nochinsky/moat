import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/** Read files in 1 MiB pieces; large enough to be fast, small enough to bound memory. */
const CHUNK_BYTES = 1024 * 1024

export type TreeHash = {
  /** Digest over (relative path, mode, kind, content/symlink target) for every entry. */
  digest: string
  files: number
  bytes: number
}

/**
 * Deterministic content hash of a directory tree.
 *
 * Used to prove the host project is byte-identical before and after an agent
 * session. Deliberately includes mode bits and symlink targets, and sorts
 * entries, so a rewrite that preserves bytes but changes permissions still
 * shows up.
 *
 * `skip` defaults to skipping `.git` because git itself rewrites index/object
 * metadata on read operations (e.g. `git status` refreshing the index), which
 * would produce false positives without telling us anything about user data.
 * Pass `{ skip: [] }` to hash the git directory too.
 */
export function hashTree(root: string, opts: { skip?: string[] } = {}): TreeHash {
  const skip = new Set(opts.skip ?? [".git"])
  const hash = crypto.createHash("sha256")
  let files = 0
  let bytes = 0

  const walk = (dir: string, rel: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name
      if (skip.has(entry.name) && !rel) continue
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
      // Streamed in chunks rather than read whole: this tree is agent-controlled
      // (it is the sandbox's /work after a session), so a multi-gigabyte file used
      // to be pulled into memory on `moat fetch`, `moat apply` and every drift
      // check. The header still carries the size, so the digest is byte-identical
      // for a file that does not change under the read.
      hash.update(`F ${entryRel} ${stat.mode & 0o7777} ${stat.size} `)
      const fd = fs.openSync(abs, "r")
      try {
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(1, stat.size)))
        let position = 0
        while (position < stat.size) {
          const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position)
          if (read <= 0) break
          hash.update(buffer.subarray(0, read))
          position += read
        }
      } finally {
        fs.closeSync(fd)
      }
      hash.update("\n")
      files += 1
      bytes += stat.size
    }
  }

  walk(root, "")
  return { digest: hash.digest("hex"), files, bytes }
}

/** Fingerprint of a secret: enough to correlate two copies, useless to an attacker. */
export function fingerprint(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`
}
