import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { checkScript } from "../../sandbox/checks.ts"

function run(script: string): { code: number; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moat-check-"))
  const file = path.join(dir, "check.sh")
  fs.writeFileSync(file, script, { mode: 0o755 })
  const result = spawnSync("sh", [file], { encoding: "utf8" })
  fs.rmSync(dir, { recursive: true, force: true })
  return { code: result.status ?? -1, output: (result.stdout ?? "") + (result.stderr ?? "") }
}

test("a check command with quotes, dollars and command substitution arrives intact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moat-check-cwd-"))
  const tick = String.fromCharCode(96)
  const command = "printf '%s\\n' 'a b' && echo \"$((1+1))\" && echo " + tick + "echo sub" + tick
  const result = run(checkScript(command, 30, dir))
  fs.rmSync(dir, { recursive: true, force: true })
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /a b/)
  assert.match(result.output, /^2$/m)
  assert.match(result.output, /sub/)
})

test("a check that ignores SIGTERM is killed after the grace period", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moat-check-trap-"))
  const started = Date.now()
  // The sleep's stdout is redirected so it does not hold the test's pipe open
  // after the shell that spawned it is killed.
  const result = run(checkScript("trap '' TERM; sleep 30 >/dev/null 2>&1", 1, dir, 1))
  const elapsed = Date.now() - started
  fs.rmSync(dir, { recursive: true, force: true })
  assert.ok(elapsed < 15000, "the check should be killed, not waited out: " + elapsed + "ms")
  assert.notEqual(result.code, 0)
  assert.match(result.output, /TIMED OUT/)
})

test("a check runs in /work by default and in the directory it is given", () => {
  // The coherence check runs the project's checks against the *accepted subset* of a change, which
  // lives in a scratch tree beside /work rather than in it (`sync/coherence.ts`). A `workdir` that
  // was accepted and then dropped would run the check against the agent's full tree, so a subset
  // that does not build would pass — the exact failure the check exists to catch.
  assert.match(checkScript("npm test", 30), /^cd \/work$/m, "no workdir means /work")
  assert.match(checkScript("npm test", 30, "/moat-verify-abc123"), /^cd \/moat-verify-abc123$/m)
})
