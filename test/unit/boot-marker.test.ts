import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { envPathsForId } from "../../lib/paths.ts"
import {
  beginBoot,
  beginBootOrWait,
  bootAgeSeconds,
  bootInFlight,
  bootMarkerPath,
  endBoot,
  waitForBoot,
  type BootRecord,
} from "../../sandbox/boot.ts"
import { processStartTime } from "../../sandbox/launcher.ts"

/** A throwaway MOAT_HOME. The path helpers read the variable at call time. */
function withHome(t: { after: (fn: () => void) => void }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moat-boot-"))
  const previous = process.env.MOAT_HOME
  process.env.MOAT_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.MOAT_HOME
    else process.env.MOAT_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

const ID = "0123456789ab"

/** A real, live process to stand in for the `moat up` doing a boot. */
function liveChild(): { pid: number; stop: () => Promise<void> } {
  const child: ChildProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" })
  const pid = child.pid!
  return {
    pid,
    stop: () =>
      new Promise((resolve) => {
        // Wait for the exit event as well as the signal: until the child is
        // reaped it still has /proc/<pid>/stat, and this test is about what a
        // reader sees after the boot process is gone.
        child.once("exit", () => resolve())
        child.kill("SIGKILL")
      }),
  }
}

function plant(p: ReturnType<typeof envPathsForId>, pid: number, pidStart: string | null): void {
  const record: BootRecord = { pid, pidStart, startedAt: new Date().toISOString(), command: "moat up" }
  fs.mkdirSync(path.dirname(bootMarkerPath(p)), { recursive: true })
  fs.writeFileSync(bootMarkerPath(p), JSON.stringify(record))
}

test("a boot marks the environment, and the mark is cleared when it ends", (t) => {
  const home = withHome(t)
  const p = envPathsForId(ID, path.join(home, "project"))
  assert.equal(bootInFlight(p), null, "nothing is booting yet")

  beginBoot(p, "moat up")
  const record = bootInFlight(p)
  assert.ok(record, "the marker is readable while the boot runs")
  assert.equal(record.pid, process.pid)
  assert.equal(record.pidStart, processStartTime(process.pid), "the pid is identified by its start time")
  assert.equal(record.command, "moat up")

  endBoot(p)
  assert.equal(bootInFlight(p), null)
  assert.equal(fs.existsSync(bootMarkerPath(p)), false, "the file goes with it")
})

test("a marker whose process is gone is forgotten, not waited on", async (t) => {
  // The bug this exists for: a boot that is killed (ctrl-c, a crash, a log.fail)
  // must not block every later command for five minutes.
  const home = withHome(t)
  const p = envPathsForId(ID, path.join(home, "project"))
  const child = liveChild()
  plant(p, child.pid, processStartTime(child.pid))
  assert.ok(bootInFlight(p), "control: the marker is believed while that process is alive")

  await child.stop()
  assert.equal(bootInFlight(p), null, "a dead boot is not in flight")
  assert.equal(fs.existsSync(bootMarkerPath(p)), false, "and its marker is reaped")
  assert.equal(await waitForBoot(p, { timeoutMs: 1000, pollMs: 10 }), "none")
})

test("a marker whose pid was reused is not believed", (t) => {
  const home = withHome(t)
  const p = envPathsForId(ID, path.join(home, "project"))
  // This process is alive, but it did not start when the marker says.
  plant(p, process.pid, "1")
  assert.equal(bootInFlight(p), null)
  assert.equal(fs.existsSync(bootMarkerPath(p)), false)
})

test("a marker for this process is not something to wait for", async (t) => {
  const home = withHome(t)
  const p = envPathsForId(ID, path.join(home, "project"))
  beginBoot(p, "moat up")
  assert.equal(await waitForBoot(p, { timeoutMs: 500, pollMs: 10 }), "none")
})

test("waiting returns when the other boot ends, and times out while it runs", async (t) => {
  const home = withHome(t)
  const p = envPathsForId(ID, path.join(home, "project"))
  const child = liveChild()
  plant(p, child.pid, processStartTime(child.pid))

  assert.equal(await waitForBoot(p, { timeoutMs: 200, pollMs: 20 }), "timeout", "still booting")

  const waiting = waitForBoot(p, { timeoutMs: 5000, pollMs: 20 })
  setTimeout(() => void child.stop(), 100)
  assert.equal(await waiting, "finished", "the marker cleared, so the wait ends")
})

test("an age is reported for the message the other command prints", () => {
  const record: BootRecord = { pid: 1, pidStart: null, startedAt: new Date(Date.now() - 7000).toISOString(), command: "moat up" }
  assert.ok(bootAgeSeconds(record) >= 6 && bootAgeSeconds(record) <= 8)
  assert.equal(bootAgeSeconds({ ...record, startedAt: "not a date" }), 0)
})

test("the boot marker is claimed atomically, so two boots cannot both win", (t) => {
  // The marker used to be a check-then-write: `cmdUp` waited for a boot in flight
  // and recorded its own marker a couple of hundred lines later, after provisioning
  // had begun. Two `moat up`s could both pass the check before either wrote, and
  // then both provision over one rootfs — provisioning replaces it, so `/work` goes
  // with it. `beginBootOrWait` is the wait and the claim in one atomic step, and the
  // claim itself is O_CREAT|O_EXCL, so a lost race is a reliable signal.
  const home = withHome(t)
  const p = envPathsForId(ID, path.join(home, "project"))
  return (async () => {
    // A foreign boot holds the marker; this process must not take it.
    const other = liveChild()
    plant(p, other.pid, processStartTime(other.pid))
    await assert.rejects(
      () => beginBootOrWait(p, "moat up", { timeoutMs: 200, pollMs: 20 }),
      /already booting this environment/,
    )
    const held = bootInFlight(p)
    assert.equal(held?.pid, other.pid, "the marker still belongs to the boot that had it")
    await other.stop()

    // With the other boot gone, the claim succeeds and the marker names this process.
    await beginBootOrWait(p, "moat up", { timeoutMs: 1000, pollMs: 20 })
    const mine = bootInFlight(p)
    assert.equal(mine?.pid, process.pid)
    assert.equal(mine?.command, "moat up")
    endBoot(p)
  })()
})

test("a claim left behind by a dead process is reclaimed, not waited on forever", (t) => {
  // The crash-recovery half: the marker carries a pid and its start time, so a
  // marker whose process is gone must not block the environment. Without this the
  // atomic claim would turn one crash into a permanently unbootable environment.
  const home = withHome(t)
  const p = envPathsForId(ID, path.join(home, "project"))
  return (async () => {
    const gone = liveChild()
    plant(p, gone.pid, processStartTime(gone.pid))
    await gone.stop()
    assert.equal(bootInFlight(p), null, "a marker whose process is gone is not a boot in flight")
    await beginBootOrWait(p, "moat up", { timeoutMs: 1000, pollMs: 20 })
    assert.equal(bootInFlight(p)?.pid, process.pid, "and the next boot can claim it")
    endBoot(p)
  })()
})

test("a stale pid recycled by another process does not hold the marker", (t) => {
  // `pidStart` is the identity, exactly as it is for the sandbox pid itself: after a
  // reboot that pid may belong to something else entirely, and a boot must not wait
  // forever on a bystander.
  const home = withHome(t)
  const p = envPathsForId(ID, path.join(home, "project"))
  return (async () => {
    const alive = liveChild()
    plant(p, alive.pid, "0") // a start time that cannot match this process
    assert.equal(bootInFlight(p), null)
    await beginBootOrWait(p, "moat up", { timeoutMs: 1000, pollMs: 20 })
    assert.equal(bootInFlight(p)?.pid, process.pid)
    endBoot(p)
    await alive.stop()
  })()
})
