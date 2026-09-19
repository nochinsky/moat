import fs from "node:fs"
import path from "node:path"

/**
 * Refuse, with a reason, a tree whose file names are not valid UTF-8.
 *
 * Node's paths are strings and `readdir` decodes names as UTF-8, so a name holding
 * a raw 0xff byte comes back containing U+FFFD — which is a *different* name, and
 * every lstat, read or hash that follows fails with ENOENT for a file that plainly
 * exists. Measured: `hashTree` threw `ENOENT: lstat '.../bad\uFFFDname'` on a tree
 * whose only sin was a filename like that.
 *
 * Supporting these names properly means Buffer paths through every host-side walk
 * (hashing, copy-in's untracked-file pass, apply's tree reads). Until that exists,
 * saying which file and which byte is wrong is worth more than a missing-file
 * error, and it is honest about the limit rather than quietly dropping the file.
 */
export function assertAddressableNames(root: string): void {
  const walk = (dir: string): void => {
    let entries: { name: Buffer; isSymbolicLink(): boolean; isDirectory(): boolean }[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true, encoding: "buffer" }) as unknown as typeof entries
    } catch {
      return
    }
    for (const entry of entries) {
      const name = entry.name
      if (!Buffer.from(name.toString("utf8"), "utf8").equals(name)) {
        const where = path.join(dir, name.toString("utf8"))
        throw new Error(
          `${where} is not a valid UTF-8 file name (bytes: ${name.toString("hex")}). ` +
            "moat addresses files by name as text, so this name cannot be handled reliably: rename it, " +
            "or keep it out of the project directory.",
        )
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(dir, name.toString("utf8")))
    }
  }
  walk(root)
}
