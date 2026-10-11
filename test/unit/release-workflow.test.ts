import assert from "node:assert/strict"
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const root = fileURLToPath(new URL("../../", import.meta.url))

test("the package and root lock have one release version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[""].version, pkg.version)
  assert.ok(pkg.files.includes("CHANGELOG.md"), "migration notes ship with the package")
})

test("the release workflow requires npm 11.5.1, not merely 11.5.0", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8")
  const block = workflow.match(/- name: npm is new enough for OIDC\n        run: \|\n([\s\S]*?)(?=\n      -)/)?.[1]
  assert.ok(block)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "moat-release-npm-"))
  try {
    fs.writeFileSync(path.join(scratch, "npm"), '#!/bin/sh\nprintf "%s\\n" "$FAKE_NPM_VERSION"\n', { mode: 0o700 })
    for (const [version, expected] of [["10.9.0", 1], ["11.4.9", 1], ["11.5.0", 1], ["11.5.1", 0], ["11.19.0", 0], ["12.0.0", 0]] as const) {
      const result: SpawnSyncReturns<string> = spawnSync("bash", ["-c", block], {
        cwd: scratch,
        env: { ...process.env, PATH: scratch + path.delimiter + process.env.PATH, FAKE_NPM_VERSION: version },
        encoding: "utf8",
      })
      assert.equal(result.status, expected, `npm ${version}: ${result.stderr}`)
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test("the paid smoke gate refuses a missing key before changing evidence or spending", () => {
  const evidence = path.join(root, "test/evidence/pi-live.txt")
  const before = fs.existsSync(evidence) ? fs.readFileSync(evidence) : null
  const result = spawnSync("bash", [path.join(root, "test/pi-live.sh")], {
    env: { ...process.env, DEEPSEEK_API_KEY: "", MOAT_CREDENTIAL: "" }, encoding: "utf8",
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /no paid request was made/)
  assert.deepEqual(fs.existsSync(evidence) ? fs.readFileSync(evidence) : null, before)
})
