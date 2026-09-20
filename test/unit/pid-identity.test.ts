import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { test } from "node:test"

import { processCommand, processStartTime, sandboxPidStatus } from "../../sandbox/launcher.ts"

test("a pid is only 'ours' when the recorded start time matches", () => {
  const pid = process.pid
  const start = processStartTime(pid)
  assert.ok(start, "the test process must have a readable /proc start time")

  assert.equal(sandboxPidStatus(pid, { startTime: start, envId: "irrelevant" }), "ours")
  assert.equal(sandboxPidStatus(pid, { startTime: "1", envId: "irrelevant" }), "stale")
  assert.equal(sandboxPidStatus(pid, { startTime: null, envId: "definitely-not-in-the-command-line" }), "stale")
  assert.equal(sandboxPidStatus(null, { startTime: start }), "gone")
  assert.equal(sandboxPidStatus(2147483646, { startTime: start }), "gone")

  // Environments written before pidStart existed fall back to the env id in the
  // command line (the boot script path carries it).
  const command = processCommand(pid)
  assert.ok(command, "the test process must have a command line")
  assert.equal(sandboxPidStatus(pid, { startTime: null, envId: "node" }), "ours")
})

test("a start time identifies the process it was read from, and only that one", () => {
  // This compared one call with itself, which is true of any function at all,
  // including one that returns a fresh random value every time. What matters is that
  // the value is stable for one process and absent for a process that is not there:
  // `sandboxPidStatus` and `stopSlirp` both decide whether it is safe to signal a
  // recorded pid from exactly this.
  const mine = processStartTime(process.pid)
  assert.ok(mine, "a live process has a start time")
  assert.equal(processStartTime(process.pid), mine, "and it does not change between reads")
  assert.equal(processStartTime(2147483646), null, "a pid with no process has no start time")
  assert.equal(processStartTime(0), null)
  // Two different processes do not share one.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" })
  try {
    const theirs = processStartTime(child.pid!)
    assert.ok(theirs)
    assert.notEqual(theirs, mine)
  } finally {
    child.kill("SIGKILL")
  }
})
