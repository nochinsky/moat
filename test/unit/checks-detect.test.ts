import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { detectChecks } from "../../lib/detect.ts"

/** A throwaway project directory holding one package.json. */
function project(t: { after: (fn: () => void) => void }, scripts: Record<string, string>, files: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moat-checks-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts }, null, 2))
  for (const file of files) fs.writeFileSync(path.join(dir, file), "")
  return dir
}

test("npm's scaffolding placeholder is not reported as a check", (t) => {
  // The bug, measured: `npm init` writes a test script that exits 1 by design, and
  // moat offered it as the project's own verdict. `moat verify` then printed FAIL for
  // a project with no tests at all, and the agent's brief told it to run that command
  // instead of the tests it might have written.
  const dir = project(t, { test: 'echo "Error: no test specified" && exit 1' })
  assert.deepEqual(detectChecks(dir), [])
})

test("the same placeholder in any quoting, or on its own line, is still not a check", (t) => {
  for (const test of [
    "echo 'Error: no test specified' && exit 1",
    '  echo "Error: no test specified" && exit 1  ',
    'echo "Error: no test specified"&&exit 1',
  ]) {
    const dir = project(t, { test })
    assert.deepEqual(detectChecks(dir), [], `script: ${test}`)
  }
})

test("an echo that cannot fail is not a check either", (t) => {
  // The other direction: it always "passes", so a green verdict from it means
  // nothing. Covering both is what makes the rule about checks rather than about npm.
  assert.deepEqual(detectChecks(project(t, { test: 'echo "no tests yet"' })), [])
  assert.deepEqual(detectChecks(project(t, { test: "echo" })), [])
})

test("a script that does real work is kept, echo or not", (t) => {
  const cases: Record<string, string> = {
    "node --test": "npm test",
    "jest --ci": "npm test",
    "echo starting && node --test": "npm test",
    "echo starting; jest": "npm test",
  }
  for (const [script, label] of Object.entries(cases)) {
    const dir = project(t, { test: script })
    const checks = detectChecks(dir)
    assert.deepEqual(checks, [{ label, command: "npm run test", kind: "test" }], `script: ${script}`)
  }
})

test("a placeholder test does not hide the lint and typecheck scripts", (t) => {
  const dir = project(t, {
    test: 'echo "Error: no test specified" && exit 1',
    lint: "eslint .",
    typecheck: "tsc --noEmit",
  })
  assert.deepEqual(
    detectChecks(dir).map((check) => [check.kind, check.command]),
    [["lint", "npm run lint"], ["types", "npm run typecheck"]],
  )
})

test("the package manager is still read from the lockfile", (t) => {
  const dir = project(t, { test: "node --test" }, ["pnpm-lock.yaml"])
  assert.deepEqual(detectChecks(dir), [{ label: "pnpm test", command: "pnpm run test", kind: "test" }])
})
