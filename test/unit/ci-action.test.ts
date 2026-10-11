import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const root = fileURLToPath(new URL("../../", import.meta.url))
const actionPath = path.join(root, ".github/actions/moat")

// The script tests did not exercise the composite action's actual relative path or output.
// Both drifted: ../../scripts did not exist, and review.txt was never produced.
test("the composite action invokes its real entrypoint and reports the produced JSON review", () => {
  const action = fs.readFileSync(path.join(actionPath, "action.yml"), "utf8")
  const run = action.match(/      run: \|\n((?:        .*(?:\n|$))+)/)?.[1]
  assert.ok(run, "the action has a shell entrypoint")
  assert.doesNotMatch(action, /--runtime\b/, "action examples use only supported Pi flags")
  const script = run.replaceAll("${{ github.action_path }}", actionPath)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "moat-ci-action-"))
  try {
    const cli = path.join(scratch, "moat")
    fs.writeFileSync(cli, `#!/usr/bin/env bash
case "$1" in
  doctor) printf '{"host":{"userns":true,"problems":[]}}\\n' ;;
  run) echo 'fake task completed' ;;
  take) printf '{"branch":"fixture","commits":1,"treeUntouched":true,"reviewed":[],"checks":null}\\n' ;;
  *) exit 9 ;;
esac
`, { mode: 0o700 })
    const output = path.join(scratch, "github-output")
    const outputDir = path.join(scratch, "review")
    execFileSync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: scratch,
      env: { ...process.env, MOAT: cli, TASK: "fixture task", MOAT_ARGS: "", OUTPUT_DIR: outputDir, GITHUB_OUTPUT: output },
      encoding: "utf8",
    })
    const review = fs.readFileSync(output, "utf8").trim().replace(/^review=/, "")
    assert.equal(review, path.join(outputDir, "review.json"))
    assert.equal(JSON.parse(fs.readFileSync(review, "utf8")).treeUntouched, true)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test("the hosted-CI namespace probe supplies an existing mount target", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8")
  const script = workflow.match(/- name: can this runner create unprivileged user namespaces\?\n[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name: list)/)?.[1]
  assert.ok(script)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "moat-ci-probe-"))
  try {
    // This fake accepts a namespace probe only if it receives a real directory as the mount target.
    fs.writeFileSync(path.join(scratch, "unshare"), '#!/bin/sh\nfor arg; do target="$arg"; done\n[ -d "$target" ]\n', { mode: 0o700 })
    const output = path.join(scratch, "github-output")
    const result = spawnSync("bash", ["-e", "-c", script], {
      cwd: scratch,
      env: { ...process.env, PATH: scratch + path.delimiter + process.env.PATH, TMPDIR: scratch, GITHUB_OUTPUT: output },
      encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(fs.readFileSync(output, "utf8"), /available=true/)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})
