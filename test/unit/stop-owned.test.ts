import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { test } from "node:test"

import { isRunning, processStartTime, stopOwnedProcess } from "../../sandbox/launcher.ts"

/**
 * A pid is not an identity, and the holder that owns the proxy's namespace is a `sleep` that can exit
 * on its own — so the number it left behind can belong to something else by the time a boot's error
 * paths reap it. Measured the way moat measures the same question for slirp
 * (`test/unit/stop-slirp.test.ts`): a *live* process with a mismatched start time must be left alone.
 */
test("a process whose start time matches is reaped", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" })
  child.unref()
  const start = processStartTime(child.pid!)
  assert.ok(start, "the start time is readable")
  assert.equal(stopOwnedProcess(child.pid!, start), true, "it was signalled")
  // A signalled child is a *zombie* until its parent reaps it, and `/proc/<pid>` stays while it is
  // one — so asking `isRunning` immediately says yes. Wait for the exit instead: the reading that
  // matters is that the process is gone, not that the number became free.
  await new Promise((resolve) => child.on("exit", resolve))
  assert.equal(isRunning(child.pid!), false, "and it is gone")
})

test("a pid whose start time does not match is never signalled", () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" })
  child.unref()
  try {
    assert.equal(
      stopOwnedProcess(child.pid!, "a-start-time-that-is-not-this-processes"),
      false,
      "nothing was signalled",
    )
    assert.equal(isRunning(child.pid!), true, "and the live process is untouched")
  } finally {
    child.kill("SIGKILL")
  }
})

test("a pid that is already gone is not an error and reports nothing reaped", () => {
  const child = spawn("true", [], { stdio: "ignore" })
  child.unref()
  return new Promise<void>((resolve) => {
    child.on("exit", () => {
      assert.equal(stopOwnedProcess(child.pid!, null), false, "a gone pid is not signalled")
      assert.equal(stopOwnedProcess(null, null), false, "and neither is no pid at all")
      resolve()
    })
  })
})
