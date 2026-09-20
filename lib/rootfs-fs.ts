import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/**
 * Host-side file operations inside the sandbox rootfs, without following the
 * agent's symlinks.
 *
 * The rootfs is persistent and the agent is root inside it, so any directory in a
 * path moat writes to may have been replaced with a symlink. The agent cannot see
 * the host filesystem, but it can write the *string* `/home/you/.codex`
 * into a symlink, and the kernel resolves that for the host process doing the
 * write: moat then clobbers a host file while believing it is writing inside the
 * box. Measured before this guard existed: an `AGENTS.md` of 3834 bytes landed in
 * a directory outside the rootfs, written on *every* boot.
 *
 * Every host-side write into the rootfs goes through here, and reads that consume
 * agent-controlled files use `readRootfsFile`, for the same reason.
 */

type LastKind = "skip" | "file" | "directory"

/**
 * The directory a write lands in, held open rather than named.
 *
 * A path check and a path use are two different moments, and the agent is root in
 * its own rootfs: between them it can replace a directory component with a symlink
 * to a host path. `writeRootfsFile` verified the temp file through `/proc/self/fd`
 * and then called `renameSync(tmp, full)`, which resolves `full` from the top
 * again — so the verification proved where the *temp* went and said nothing about
 * where the rename went.
 *
 * A directory descriptor closes that: once the parent is open and verified, the
 * file is created and renamed through `/proc/self/fd/<dirfd>/<name>`, which the
 * kernel resolves to the directory that was opened, not to whatever the path
 * means now. Measured consequence of a swap after the open: the operation fails
 * with ENOENT (the held directory has no name left to reach it by) and nothing is
 * written, which is the safe direction. Opening with O_NOFOLLOW|O_DIRECTORY makes
 * a symlinked component fail with ENOTDIR.
 */
type ParentDir = { fd: number; path: string }

/**
 * Check and create every directory on the way, then open the *parent* directory
 * of the target as a descriptor.
 *
 * The last component is a name, not a directory to walk into: a symlink sitting
 * there is the normal case and gets replaced by the rename. The directory that
 * holds it is the thing that has to be verified and held open.
 *
 * Throws with the same wording the path walker used, so the messages the tests and
 * the docs quote ("refusing to follow a symlink inside the sandbox rootfs") stay
 * the same.
 */
function openParentDir(rootfs: string, target: string): ParentDir {
  const root = fs.realpathSync(rootfs)
  const parts = (path.isAbsolute(target) ? target.slice(1) : target).split("/").filter((part) => part.length > 0)
  if (parts.length < 2) throw new Error(`refusing to write to the sandbox rootfs itself: ${target}`)
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`refusing a path that leaves the sandbox rootfs: ${target}`)
  }

  let current = root
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part)
    let stat: fs.Stats | null = null
    try {
      stat = fs.lstatSync(current)
    } catch {
      stat = null
    }
    if (stat === null) {
      fs.mkdirSync(current, { mode: 0o755 })
      continue
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `refusing to follow a symlink inside the sandbox rootfs: ${path.relative(root, current)} -> ${fs.readlinkSync(current)}`,
      )
    }
    if (!stat.isDirectory()) {
      throw new Error(`refusing to write through a non-directory inside the sandbox rootfs: ${path.relative(root, current)}`)
    }
  }

  const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  // The descriptor has to be the directory that was walked, not a second resolve
  // of the same string.
  const opened = fs.readlinkSync(`/proc/self/fd/${fd}`)
  if (opened !== current) {
    fs.closeSync(fd)
    throw new Error(`refusing to write outside the sandbox rootfs: ${opened} is not ${current}`)
  }
  return { fd, path: current }
}

/** Remove a temp file through the directory it was created in, by name only. */
function removeThroughDir(dir: ParentDir, name: string): void {
  try {
    fs.unlinkSync(`/proc/self/fd/${dir.fd}/${name}`)
  } catch {
    /* it was already renamed into place, or the directory is gone */
  }
}

/** Resolve a path inside the rootfs, refusing every symlink on the way. */
function walk(rootfs: string, target: string, opts: { create: boolean; last: LastKind }): string {
  const root = fs.realpathSync(rootfs)
  const parts = (path.isAbsolute(target) ? target.slice(1) : target).split("/").filter((part) => part.length > 0)
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`refusing a path that leaves the sandbox rootfs: ${target}`)
  }
  let current = root
  for (const [index, part] of parts.entries()) {
    const isLast = index === parts.length - 1
    current = path.join(current, part)
    if (isLast && opts.last === "skip") return current
    let stat: fs.Stats | null = null
    try {
      stat = fs.lstatSync(current)
    } catch {
      stat = null
    }
    if (stat === null) {
      if (!opts.create || (isLast && opts.last === "file")) {
        throw new Error(`no such path inside the sandbox rootfs: ${target}`)
      }
      fs.mkdirSync(current, { mode: 0o755 })
      continue
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `refusing to follow a symlink inside the sandbox rootfs: ${path.relative(root, current)} -> ${fs.readlinkSync(current)}`,
      )
    }
    if (isLast && opts.last === "file" && !stat.isFile()) {
      throw new Error(`refusing to read a non-file inside the sandbox rootfs: ${path.relative(root, current)}`)
    }
    if (isLast && opts.last === "directory" && !stat.isDirectory()) {
      throw new Error(`refusing to treat a non-directory as a directory inside the sandbox rootfs: ${path.relative(root, current)}`)
    }
    if (!isLast && !stat.isDirectory()) {
      throw new Error(`refusing to write through a non-directory inside the sandbox rootfs: ${path.relative(root, current)}`)
    }
  }
  return current
}

/**
 * Write a file inside the rootfs, atomically, without following a symlink.
 *
 * The temp file is created with O_EXCL|O_NOFOLLOW beside the target and renamed
 * over it: rename replaces a symlink at the target instead of writing through it,
 * so a reader sees either the old file or the new one, never a partial script.
 *
 * Both the create and the rename go through a descriptor for the parent directory
 * rather than the path again, because the agent can swap a directory for a symlink
 * between the check and the use. See `ParentDir`.
 */
export function writeRootfsFile(rootfs: string, target: string, content: string | Buffer, mode = 0o644): string {
  const dir = openParentDir(rootfs, target)
  const name = path.basename(target)
  // Never the deterministic name: a fixed `.foo.tmp` lets the agent pre-create it,
  // and O_EXCL then fails a boot it could have made succeed. Random, retried a few
  // times, and only then reported.
  let tmpName = ""
  let fd: number | null = null
  try {
    for (let attempt = 0; attempt < 8 && fd === null; attempt++) {
      const candidate = `.${name}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`
      try {
        fd = fs.openSync(
          `/proc/self/fd/${dir.fd}/${candidate}`,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          mode,
        )
        tmpName = candidate
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
    }
    if (fd === null) throw new Error(`could not create a temp file beside ${target} inside the sandbox rootfs`)

    // The walk and the open can still be raced; /proc/self/fd names the file that was
    // actually opened, so a swapped directory cannot redirect this write.
    const opened = fs.readlinkSync(`/proc/self/fd/${fd}`)
    if (path.dirname(opened) !== dir.path || path.basename(opened) !== tmpName) {
      throw new Error(`refusing to write outside the sandbox rootfs: opened ${opened}`)
    }
    // A single write() may be short; loop so a partial script is never renamed in.
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content
    let written = 0
    while (written < bytes.length) written += fs.writeSync(fd, bytes, written)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(`/proc/self/fd/${dir.fd}/${tmpName}`, `/proc/self/fd/${dir.fd}/${name}`)
    return path.join(dir.path, name)
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed */
      }
    }
    if (tmpName.length > 0) removeThroughDir(dir, tmpName)
    throw error
  } finally {
    fs.closeSync(dir.fd)
  }
}

/**
 * Open a file inside the rootfs for appending, without following a symlink.
 *
 * The returned descriptor is handed to a child process, so the child never
 * resolves an agent-writable path: it dups the descriptor (`exec 1>&3`), and a
 * symlink swapped in after this call cannot move the write.
 */
export function openRootfsFileForAppend(rootfs: string, target: string, mode = 0o600): number {
  const full = walk(rootfs, target, { create: true, last: "skip" })
  const fd = fs.openSync(
    full,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
    mode,
  )
  try {
    const opened = fs.readlinkSync(`/proc/self/fd/${fd}`)
    if (opened !== full) throw new Error(`refusing to open outside the sandbox rootfs: ${opened}`)
    return fd
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

/** Create a directory inside the rootfs, refusing symlinked components. */
export function ensureRootfsDir(rootfs: string, target: string, mode = 0o755): string {
  const full = walk(rootfs, target, { create: true, last: "directory" })
  if (!fs.existsSync(full)) fs.mkdirSync(full, { mode })
  return full
}

/** chmod a directory inside the rootfs; a symlinked one is refused, not followed. */
export function chmodRootfsDir(rootfs: string, target: string, mode: number): void {
  fs.chmodSync(walk(rootfs, target, { create: false, last: "directory" }), mode)
}

/**
 * Read a file inside the rootfs. A symlinked or missing path reads as null.
 *
 * `maxBytes` protects the caller from a file the agent grew: an oversized file
 * reads as null rather than being pulled into memory. Pass a cap for anything
 * that is later parsed (a 10 GB JSON config is a denial of service, not a config).
 */
export function readRootfsFile(rootfs: string, target: string, opts: { maxBytes?: number } = {}): string | null {
  return read(rootfs, target, (size, fd) => {
    if (opts.maxBytes !== undefined && size > opts.maxBytes) return null
    return fs.readFileSync(fd, "utf8")
  })
}

/**
 * The last `maxBytes` of a file inside the rootfs.
 *
 * Used for logs: the whole point of a log is that something else decides how big
 * it gets, and inside the box that something is the agent. A cut can split a
 * multi-byte character at the start; the caller shows the last lines anyway.
 */
export function readRootfsFileTail(rootfs: string, target: string, maxBytes: number): string | null {
  return read(rootfs, target, (size, fd) => {
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    const buffer = Buffer.allocUnsafe(length)
    let position = 0
    while (position < length) {
      const chunk = fs.readSync(fd, buffer, position, length - position, start + position)
      if (chunk <= 0) break
      position += chunk
    }
    return buffer.subarray(0, position).toString("utf8")
  })
}

/**
 * The first `maxBytes` of a file inside the rootfs.
 *
 * The mirror of the tail reader, for records written at the *start* of a file that
 * then grows without bound: the plugin's config record is the first line of the
 * audit log, which gains a line per tool call.
 */
export function readRootfsFileHead(rootfs: string, target: string, maxBytes: number): string | null {
  return read(rootfs, target, (size, fd) => {
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.allocUnsafe(length)
    let position = 0
    while (position < length) {
      const chunk = fs.readSync(fd, buffer, position, length - position, position)
      if (chunk <= 0) break
      position += chunk
    }
    return buffer.subarray(0, position).toString("utf8")
  })
}

/** The shared open-verify-read dance behind both readers. */
function read(rootfs: string, target: string, consume: (size: number, fd: number) => string | null): string | null {
  let full: string
  try {
    full = walk(rootfs, target, { create: false, last: "file" })
  } catch {
    return null
  }
  let fd: number | null = null
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    return consume(fs.fstatSync(fd).size, fd)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }
}
