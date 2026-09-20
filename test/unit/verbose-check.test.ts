import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const WITNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "verbose-witness.ts")

/**
 * Run the witness in its own process and return its stderr.
 *
 * Out of process because `log.debug` writes to the test process's own stderr, and a
 * test that captured that would be racing the runner's reporter.
 */
function witness(mode: string, env: Record<string, string> = {}): string {
  const result = spawnSync(process.execPath, [WITNESS, mode], {
    encoding: "utf8",
    // A clean slate for the variable the module used to read at load time.
    env: { ...process.env, MOAT_VERBOSE: "", ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stderr
}

test("setVerbose turns the debug lines on, and leaving it alone leaves them off", () => {
  // The defect: `lib/log.ts` read `MOAT_VERBOSE` once at module load and `main()`
  // assigned the variable afterwards, so the constant was always its pre-change value
  // and all thirteen `log.debug` sites were unreachable. `--verbose` printed exactly
  // what no flag printed. This is the mechanism half of the claim; `e2e-extras.sh`
  // section Z is the end-to-end half.
  const off = witness("off")
  assert.match(off, /VERBOSE-WITNESS: this line is always printed/, "the control line must be there")
  assert.doesNotMatch(off, /this line only exists when verbose is on/, "nothing switched it on")

  const on = witness("on")
  assert.match(on, /this line only exists when verbose is on/, "setVerbose must make debug reach stderr")
  assert.match(on, /this line is always printed/, "and must not suppress anything else")
})

test("the environment variable still switches it on by itself", () => {
  // `MOAT_VERBOSE=1` is documented and is what a caller with no flag relies on; it is
  // read at module load, which is early enough for a value that was set before the
  // process started.
  assert.match(witness("env", { MOAT_VERBOSE: "1" }), /only exists when verbose is on/)
  assert.doesNotMatch(witness("env", { MOAT_VERBOSE: "0" }), /only exists when verbose is on/)
})
