import assert from "node:assert/strict"
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

test("two reads of the same process agree on its start time", () => {
  assert.equal(processStartTime(process.pid), processStartTime(process.pid))
})
