import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { test } from "node:test"

import { stopSlirp } from "../../sandbox/launcher.ts"

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
  await stopSlirp(null, null)
  await stopSlirp(0, null)
})
