import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { installBundle } from "../../bundle/install.ts"
import { chmodRootfsDir, ensureRootfsDir, readRootfsFile, writeRootfsFile } from "../../lib/rootfs-fs.ts"

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

test("ensureRootfsDir creates directories and refuses symlinked components", (t) => {
  const { rootfs, outside } = withDirs(t)
  const created = ensureRootfsDir(rootfs, "/usr/local/share/moat/plugin")
  assert.equal(fs.statSync(created).isDirectory(), true)
  fs.symlinkSync(outside, path.join(rootfs, "escape"))
  assert.throws(() => ensureRootfsDir(rootfs, "/escape/deeper"), /symlink/)
  assert.deepEqual(fs.readdirSync(outside), [])
})
