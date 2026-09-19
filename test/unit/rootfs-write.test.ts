import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import type { EnvPaths } from "../../lib/paths.ts"
import { installBundle } from "../../bundle/install.ts"
import { outerScript } from "../../sandbox/launcher.ts"
import {
  chmodRootfsDir,
  ensureRootfsDir,
  openRootfsFileForAppend,
  readRootfsFile,
  readRootfsFileHead,
  readRootfsFileTail,
  writeRootfsFile,
} from "../../lib/rootfs-fs.ts"

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function withDirs(t: { after: (fn: () => void) => void }): { rootfs: string; outside: string } {
  const rootfs = temp("moat-rootfs-")
  const outside = temp("moat-outside-")
  t.after(() => {
    fs.rmSync(rootfs, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })
  return { rootfs, outside }
}

function installOptions() {
  return {
    render: {
      provider: { opencodeID: "deepseek", npm: "", native: true },
      modelID: "deepseek-flash",
      baseUrl: "",
      preset: "core" as const,
    },
    brief: {
      provider: "DeepSeek",
      model: "deepseek/deepseek-flash",
      branch: "moat-session",
      profiles: [] as string[],
      installedPackages: [] as string[],
      hasCredential: true,
      canAsk: false,
      egress: "open" as const,
      checks: [],
    },
    installedPackages: [] as string[],
  }
}

test("the bundle install refuses to write through a symlink the agent planted", (t) => {
  // Measured before the guard: the agent replaces /root/.config/opencode with a
  // symlink to a host directory, and every boot writes AGENTS.md (3834 bytes)
  // into it — outside the sandbox, on every boot, with no error anywhere.
  const { rootfs, outside } = withDirs(t)
  fs.mkdirSync(path.join(rootfs, "root", ".config"), { recursive: true })
  fs.symlinkSync(outside, path.join(rootfs, "root", ".config", "opencode"))

  assert.throws(() => installBundle(rootfs, installOptions()), /symlink/)
  assert.deepEqual(fs.readdirSync(outside), [])
})

test("a normal bundle install still writes every file, inside the rootfs", (t) => {
  const { rootfs } = withDirs(t)
  installBundle(rootfs, installOptions())
  for (const target of [
    "usr/local/share/moat/opencode.json",
    "usr/local/share/moat/tools.json",
    "usr/local/share/moat/environment.json",
    "usr/local/share/moat/plugin/moat-bundle.mjs",
    "root/.config/opencode/AGENTS.md",
  ]) {
    assert.equal(fs.existsSync(path.join(rootfs, target)), true, target)
  }
})

test("writing inside the rootfs creates parents and replaces content", (t) => {
  const { rootfs } = withDirs(t)
  const file = writeRootfsFile(rootfs, "/var/log/moat/run.txt", "first", 0o600)
  assert.equal(file, path.join(fs.realpathSync(rootfs), "var/log/moat/run.txt"))
  assert.equal(fs.readFileSync(file, "utf8"), "first")
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  writeRootfsFile(rootfs, "/var/log/moat/run.txt", "second")
  assert.equal(fs.readFileSync(file, "utf8"), "second")
})

test("a symlinked parent directory is refused, and the host target is untouched", (t) => {
  const { rootfs, outside } = withDirs(t)
  fs.mkdirSync(path.join(rootfs, "root"), { recursive: true })
  fs.symlinkSync(outside, path.join(rootfs, "root", ".config"))

  assert.throws(() => writeRootfsFile(rootfs, "/root/.config/AGENTS.md", "x"), /symlink/)
  assert.deepEqual(fs.readdirSync(outside), [])
})

test("a symlink at the file itself is replaced, not followed", (t) => {
  const { rootfs, outside } = withDirs(t)
  const secret = path.join(outside, "host-file")
  fs.writeFileSync(secret, "host content")
  fs.mkdirSync(path.join(rootfs, "etc"), { recursive: true })
  fs.symlinkSync(secret, path.join(rootfs, "etc", "hosts"))

  writeRootfsFile(rootfs, "/etc/hosts", "sandbox content")
  assert.equal(fs.readFileSync(secret, "utf8"), "host content")
  assert.equal(fs.lstatSync(path.join(rootfs, "etc", "hosts")).isSymbolicLink(), false)
  assert.equal(fs.readFileSync(path.join(rootfs, "etc", "hosts"), "utf8"), "sandbox content")
})

test("a path that climbs out of the rootfs is refused", (t) => {
  const { rootfs } = withDirs(t)
  assert.throws(() => writeRootfsFile(rootfs, "/etc/../../escape", "x"), /leaves the sandbox/)
})

test("chmod refuses a symlinked directory instead of chmodding the host's", (t) => {
  const { rootfs, outside } = withDirs(t)
  fs.chmodSync(outside, 0o700)
  fs.symlinkSync(outside, path.join(rootfs, "usr"))
  assert.throws(() => chmodRootfsDir(rootfs, "/usr", 0o755), /symlink/)
  assert.equal(fs.statSync(outside).mode & 0o777, 0o700)
})

test("reading a symlinked boot log returns nothing rather than a host file", (t) => {
  const { rootfs, outside } = withDirs(t)
  const secret = path.join(outside, "id_rsa")
  fs.writeFileSync(secret, "host secret")
  fs.mkdirSync(path.join(rootfs, "var", "log", "moat"), { recursive: true })
  fs.symlinkSync(secret, path.join(rootfs, "var", "log", "moat", "boot.log"))

  assert.equal(readRootfsFile(rootfs, "/var/log/moat/boot.log"), null)
  // A real file in the same place still reads.
  fs.rmSync(path.join(rootfs, "var", "log", "moat", "boot.log"))
  fs.writeFileSync(path.join(rootfs, "var", "log", "moat", "boot.log"), "boot output")
  assert.equal(readRootfsFile(rootfs, "/var/log/moat/boot.log"), "boot output")
})

test("an agent-sized file reads as nothing, and a tail read stays bounded", (t) => {
  // The log inside the box is the agent's to grow: "moat logs sandbox" used to
  // read the whole file, so a multi-gigabyte boot.log was a memory exhaustion
  // handed to the host by the box.
  const { rootfs } = withDirs(t)
  fs.mkdirSync(path.join(rootfs, "var", "log", "moat"), { recursive: true })
  const big = path.join(rootfs, "var", "log", "moat", "boot.log")
  fs.writeFileSync(big, "a".repeat(4096) + "THE-END")
  assert.equal(fs.statSync(big).size, 4103)

  assert.equal(readRootfsFile(rootfs, "/var/log/moat/boot.log", { maxBytes: 4096 }), null)
  assert.equal(readRootfsFile(rootfs, "/var/log/moat/boot.log", { maxBytes: 8192 })?.endsWith("THE-END"), true)
  const tail = readRootfsFileTail(rootfs, "/var/log/moat/boot.log", 16)
  assert.equal(tail?.length, 16)
  assert.equal(tail?.endsWith("THE-END"), true)
  const head = readRootfsFileHead(rootfs, "/var/log/moat/boot.log", 16)
  assert.equal(head, "a".repeat(16))
  assert.equal(readRootfsFileHead(rootfs, "/var/log/moat/boot.log", 100_000)?.endsWith("THE-END"), true)
  assert.equal(readRootfsFileTail(rootfs, "/var/log/moat/boot.log", 100_000)?.endsWith("THE-END"), true)

  // A symlink is refused by both readers, cap or no cap.
  fs.symlinkSync(big, path.join(rootfs, "var", "log", "moat", "link.log"))
  assert.equal(readRootfsFile(rootfs, "/var/log/moat/link.log"), null)
  assert.equal(readRootfsFileTail(rootfs, "/var/log/moat/link.log", 16), null)
  assert.equal(readRootfsFile(rootfs, "/var/log/moat/missing.log"), null)
})

test("the boot script never resolves the log path; it dups a verified descriptor", (t) => {
  // The redirect used to be `exec >> <rootfs>/var/log/moat/boot.log`, a path
  // resolve in the boot shell: a symlink swapped into the agent-writable rootfs
  // pointed the *host's* write at a host directory. The host opens and verifies
  // the log now and passes it as fd 3.
  const { rootfs } = withDirs(t)
  const p = { mountpoint: path.join(rootfs, "mnt"), rootfs, entryScript: path.join(rootfs, ".moat/entry.sh") } as EnvPaths
  const script = outerScript(p, { bootLog: true })
  assert.match(script, /exec 1>&3 2>&3/)
  assert.doesNotMatch(script, /exec >>/)
  assert.equal(script.includes(rootfs), true) // the boot still binds the rootfs
  assert.equal(script.includes("boot.log"), false)
  // Without the option (ephemeral boots that capture output) nothing is duped.
  assert.doesNotMatch(outerScript(p), /exec 1>&3/)
})

test("opening the boot log for append refuses a symlink and writes nothing outside", (t) => {
  const { rootfs, outside } = withDirs(t)
  const host = path.join(outside, "boot.log")
  fs.writeFileSync(host, "host content\n")
  fs.mkdirSync(path.join(rootfs, "var", "log", "moat"), { recursive: true })
  fs.symlinkSync(host, path.join(rootfs, "var", "log", "moat", "boot.log"))
  assert.throws(() => openRootfsFileForAppend(rootfs, "/var/log/moat/boot.log"), /ELOOP|symlink/)
  assert.equal(fs.readFileSync(host, "utf8"), "host content\n")

  // A real file in the same place opens for append and keeps what was there.
  fs.rmSync(path.join(rootfs, "var", "log", "moat", "boot.log"))
  const fd = openRootfsFileForAppend(rootfs, "/var/log/moat/boot.log")
  fs.writeSync(fd, "appended\n")
  fs.closeSync(fd)
  assert.equal(fs.readFileSync(path.join(rootfs, "var", "log", "moat", "boot.log"), "utf8"), "appended\n")
})

test("ensureRootfsDir creates directories and refuses symlinked components", (t) => {
  const { rootfs, outside } = withDirs(t)
  const created = ensureRootfsDir(rootfs, "/usr/local/share/moat/plugin")
  assert.equal(fs.statSync(created).isDirectory(), true)
  fs.symlinkSync(outside, path.join(rootfs, "escape"))
  assert.throws(() => ensureRootfsDir(rootfs, "/escape/deeper"), /symlink/)
  assert.deepEqual(fs.readdirSync(outside), [])
})
