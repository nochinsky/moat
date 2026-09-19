import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { installBundle } from "../../bundle/install.ts"

function options(checks: { label: string; command: string }[]) {
  return {
    render: {
      provider: { opencodeID: "deepseek", npm: "", native: true },
      modelID: "deepseek-flash",
      baseUrl: "",
      preset: "core" as const,
    },
    brief: {
      provider: "DeepSeek",
      model: "deepseek/deepseek-flash",
      branch: "moat-session",
      profiles: [] as string[],
      installedPackages: [] as string[],
      hasCredential: true,
      canAsk: false,
      checks,
    },
    installedPackages: [] as string[],
  }
}

test("a literal key in any written artifact is refused", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-install-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  // The old regex missed this shape entirely: the hyphen ended the run.
  const projectCheck = [{ label: "test", command: "curl -H 'Authorization: Bearer sk-proj-" + "A".repeat(40) + "'" }]
  assert.throws(() => installBundle(root, options(projectCheck)), /literal API key/)

  // A clean bundle installs, and the check file records the real curated set.
  const clean = installBundle(root, options([{ label: "test", command: "npm test" }]))
  assert.deepEqual(clean.curated, ["read", "write", "edit", "apply_patch", "glob", "grep", "bash", "todowrite", "question"])
  const tools = JSON.parse(fs.readFileSync(path.join(root, clean.tools), "utf8")) as { curated: string[] }
  assert.ok(tools.curated.includes("question"))
})
