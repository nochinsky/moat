import assert from "node:assert/strict"
import { test } from "node:test"

import { validateLogName } from "../../lib/paths.ts"

test("a log name that is not a plain file name is refused", () => {
  // The bug, measured: `moat logs` joined argv into the environment's log
  // directory, so `moat logs ../../../../../tmp/moat-traversal` printed
  // /tmp/moat-traversal.log — a host file outside the environment. Same rule as
  // snapshot names: validate before the join.
  for (const good of ["build", "a.b-c_d1", "A1", "x".repeat(64)]) {
    assert.equal(validateLogName(good), good)
  }
  for (const bad of ["../evil", "a/b", "", ".hidden", "with space", "x".repeat(65), "..", "-dash"]) {
    assert.throws(() => validateLogName(bad), /invalid log name/)
  }
})
