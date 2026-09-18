import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

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

/** Fingerprint of a secret: enough to correlate two copies, useless to an attacker. */
export function fingerprint(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`
}
