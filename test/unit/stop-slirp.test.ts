import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { test } from "node:test"

import { processStartTime, stopSlirp } from "../../sandbox/launcher.ts"

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("a recorded slirp pid is only signalled while it is the process that was recorded", async () => {
  // After a reboot, or after the datapath died and its number was reused, the pid in
  // state.json can belong to somebody else. The start-time comparison is the only thing
  // between moat and a bystander's process, and nothing tested it before this.
  const child = spawn("sleep", ["30"], { stdio: "ignore" })
  const pid = child.pid!
  try {
    await stopSlirp(pid, "a-start-time-that-is-not-this-process")
    assert.equal(alive(pid), true, "a mismatched start time must not signal")
    await stopSlirp(pid, null)
    assert.equal(alive(pid), false, "with no recorded time the pid is moat's to reap")
  } finally {
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        /* already gone */
      }
    }
    child.removeAllListeners()
  }
})

test("stopSlirp with nothing recorded is a no-op", async () => {
  // The assertions are the point: this test called stopSlirp twice and checked
  // nothing, so it passed for any behaviour at all, including one that threw.
  assert.equal(await stopSlirp(null, null), false)
  assert.equal(await stopSlirp(0, null), false)
  // A pid that is not running is not something it can have stopped, and the caller
  // prints "reaped the datapath" on the strength of a true return.
  assert.equal(await stopSlirp(2147483646, null), false)
})

test("a start time that does not match the process is a refusal, not a kill", async (t) => {
  // The other half of the same guard, stated on its own so a change to either half
  // fails a test: `stopSlirp` returns true only when it actually signalled a live
  // process whose recorded start time matched, and the caller prints "reaped the
  // datapath" on the strength of that.
  const child = spawn("sleep", ["30"], { stdio: "ignore" })
  const pid = child.pid!
  t.after(() => {
    if (alive(pid)) process.kill(pid, "SIGKILL")
  })
  assert.equal(await stopSlirp(pid, "0"), false, "a mismatched identity is not ours to stop")
  assert.equal(alive(pid), true, "so it is still running")
  const start = processStartTime(pid)
  assert.ok(start, "a live child has a start time")
  assert.equal(await stopSlirp(pid, start), true, "the matching process is stopped")
  assert.equal(alive(pid), false)
})
