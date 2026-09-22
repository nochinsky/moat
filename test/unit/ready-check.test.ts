import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import type { EnvPaths } from "../../lib/paths.ts"
import { READY_MARKER, isRunning, startSandbox, waitForSandboxReady } from "../../sandbox/launcher.ts"

/** A child that stays up long enough to be polled, then exits when told to. */
function stayUp(): { pid: number; stop: () => void } {
  const child = spawn("sleep", ["30"], { stdio: "ignore" })
  child.unref()
  return { pid: child.pid!, stop: () => child.kill("SIGKILL") }
}

test("a boot that never says it is ready fails instead of being reported as up", async () => {
  // The bug: `moat up` declared success as soon as `unshare` had been spawned,
  // because "the codex runtime has no server to wait for". An already-expired
  // credential makes the entry script print its expiry line and exit 0 in
  // milliseconds, so `moat up` wrote `status: "running"` and a pid into state.json
  // for a process that was already gone, and the next command reported a sandbox
  // that was not there. The wait resolves on the entry script's own readiness line.
  const { pid, stop } = stayUp()
  try {
    const result = await waitForSandboxReady(pid, () => "[moat] runtime ready (pid 7)\n", { pollMs: 5 })
    assert.equal(result.ok, true)
  } finally {
    stop()
  }
})

test("the readiness line has to be the entry script's, not any output", async () => {
  const { pid, stop } = stayUp()
  try {
    // A box that is up but has not reached the marker yet is not ready: the mounts
    // and the credential check come first, and the whole point is to wait for them.
    const pending = await waitForSandboxReady(pid, () => "[moat] mounting /dev\n", {
      pollMs: 5,
      deadlineMs: 60,
    })
    assert.equal(pending.ok, false)
    if (!pending.ok) assert.match(pending.reason, /did not finish booting/)
  } finally {
    stop()
  }
})

test("a box that dies during boot is reported with its log, not as running", async () => {
  // The expired-credential path, modelled: the process is gone before the marker
  // ever appears. The failure carries the reason and the last log lines, because
  // "the sandbox exited" without them sends the user to `moat logs` to find out why.
  const child = spawn("sh", ["-c", "echo '[moat] the injected credential expired before the box started; stopping'; exit 0"], {
    stdio: "ignore",
  })
  const pid = child.pid!
  // Let it exit; waitForSandboxReady must notice even if the first poll is late.
  await new Promise((resolve) => child.on("exit", resolve))
  assert.equal(isRunning(pid), false, "the child really is gone before the wait starts")
  const result = await waitForSandboxReady(pid, () => "[moat] the injected credential expired before the box started; stopping\n", {
    pollMs: 5,
    deadlineMs: 200,
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.reason, /exited during boot/)
    assert.match(String(result.log), /credential expired/)
  }
})

test("a log that cannot be read yet is not a failure on its own", async () => {
  // The boot log is created by the host before the spawn, but a read can still come
  // back null (the guard refuses a symlinked path, the file is not there yet). That
  // is "not ready yet", not "died": only the process being gone is a death.
  const { pid, stop } = stayUp()
  let reads = 0
  try {
    const result = await waitForSandboxReady(
      pid,
      () => {
        reads += 1
        return reads < 3 ? null : `${READY_MARKER} (pid 9)\n`
      },
      { pollMs: 5 },
    )
    assert.equal(result.ok, true)
    assert.ok(reads >= 3, "it kept polling rather than giving up on a null read")
  } finally {
    stop()
  }
})

/**
 * A throwaway rootfs with just enough of a userspace for `/bin/sh` to start.
 *
 * The boot script chroots into this and runs the inner script, so the check below
 * exercises the real spawn path (unshare, the mounts, the chroot, the boot log
 * descriptor) rather than a model of it. Copying whole library trees would drag in
 * unreadable host directories, so only what the shell itself needs comes along.
 */
function throwawayEnv(t: { after: (fn: () => void) => void }): EnvPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-ready-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const rootfs = path.join(root, "rootfs")
  for (const dir of ["bin", "etc", "proc", "dev", "tmp", "run", "var/log/moat", ".moat", "usr/bin", "usr/sbin", "sbin"]) {
    fs.mkdirSync(path.join(rootfs, dir), { recursive: true })
  }
  fs.copyFileSync("/bin/sh", path.join(rootfs, "bin/sh"))
  fs.chmodSync(path.join(rootfs, "bin/sh"), 0o755)
  for (const dep of ["/lib/x86_64-linux-gnu/libc.so.6", "/lib64/ld-linux-x86-64.so.2"]) {
    if (!fs.existsSync(dep)) continue
    const dest = path.join(rootfs, dep)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(fs.realpathSync(dep), dest)
  }
  fs.mkdirSync(path.join(root, "logs"), { recursive: true })
  fs.mkdirSync(path.join(root, "mnt"), { recursive: true })
  return {
    id: "ready-check",
    projectDir: root,
    dir: root,
    rootfs,
    work: path.join(rootfs, "work"),
    mountpoint: path.join(root, "mnt"),
    state: path.join(root, "state.json"),
    logs: path.join(root, "logs"),
    snapshots: path.join(root, "snapshots"),
    entryScript: path.join(rootfs, ".moat", "entry.sh"),
    auditDir: path.join(rootfs, "var/log/moat"),
  }
}

test("a real boot whose entry script dies early is not reported as up", async (t) => {
  // End to end on the spawn path, not just the poll loop above: this is the defect
  // as it was measured. `startSandbox` spawns, the inner script exits before it can
  // print the readiness line (exactly what an already-dead credential makes the
  // entry script do), and the wait has to come back with the reason and the log.
  // Skipped when the environment cannot make a user namespace, which is the case on
  // GitHub's hosted runners.
  const p = throwawayEnv(t)
  const probe = spawn("unshare", ["--user", "--map-root-user", "true"], { stdio: "ignore" })
  const canUnshare = await new Promise<boolean>((resolve) => {
    probe.on("error", () => resolve(false))
    probe.on("exit", (code) => resolve(code === 0))
  })
  if (!canUnshare) {
    t.skip("no unprivileged user namespaces here")
    return
  }

  const sandbox = await startSandbox(
    p,
    '#!/bin/sh\necho "[moat] the injected credential expired before the box started; stopping"\nexit 0\n',
    { TERM: "dumb" },
    { egress: "open" },
  )
  const readLog = (): string | null => {
    try {
      return fs.readFileSync(path.join(p.rootfs, "var/log/moat/boot.log"), "utf8")
    } catch {
      return null
    }
  }
  const result = await waitForSandboxReady(sandbox.pid, readLog, { pollMs: 10, deadlineMs: 10_000 })
  assert.equal(result.ok, false, "a box that died before its ready line is not ready")
  if (!result.ok) {
    assert.match(result.reason, /exited during boot/)
    assert.match(String(result.log), /credential expired before the box started/)
  }
  assert.equal(isRunning(sandbox.pid), false, "and the box really is gone")
})
