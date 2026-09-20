import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { installCodexFiles } from "../../bundle/codex.ts"
import { renderInstructions } from "../../bundle/instructions.ts"

const BRIEF = {
  provider: "DeepSeek",
  model: "deepseek/deepseek-flash",
  branch: "moat-session",
  profiles: [] as string[],
  installedPackages: [] as string[],
  hasCredential: true,
  canAsk: false,
  egress: "open" as const,
  workspace: "/work",
}

function tempRoot(t: { after: (fn: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-install-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test("a literal key in either file written into the sandbox is refused", (t) => {
  const root = tempRoot(t)
  // The old regex missed this shape entirely: the hyphen ended the run.
  const command = "curl -H 'Authorization: Bearer sk-proj-" + "A".repeat(40) + "'"
  const brief = renderInstructions({ ...BRIEF, checks: [{ label: "test", command }] })
  assert.throws(() => installCodexFiles(root, { config: 'model = "deepseek-flash"\n', brief }), /literal API key/)
  // The refused call writes none of the three files: a half-installed set is its own bug.
  assert.equal(fs.existsSync(path.join(root, "root/.codex/AGENTS.md")), false)
  assert.equal(fs.existsSync(path.join(root, "root/.codex/config.toml")), false)
  assert.equal(fs.existsSync(path.join(root, "root/.codex/models.json")), false)
})

test("a clean config, brief and model catalog are written where Codex reads them, and nowhere else", (t) => {
  const root = tempRoot(t)
  const config = 'model = "deepseek-flash"\napproval_policy = "never"\n'
  const brief = renderInstructions({ ...BRIEF, checks: [{ label: "test", command: "npm test" }] })
  installCodexFiles(root, { config, brief })
  assert.equal(fs.readFileSync(path.join(root, "root/.codex/config.toml"), "utf8"), config)
  assert.equal(fs.readFileSync(path.join(root, "root/.codex/AGENTS.md"), "utf8"), brief)
  // The catalog goes in byte-for-byte: the file Codex parses is the file in this repository, not a
  // re-serialization of it. `renderCodexConfig` names this exact path in model_catalog_json.
  const vendored = fs.readFileSync(new URL("../../bundle/deepseek-models.json", import.meta.url), "utf8")
  const installed = fs.readFileSync(path.join(root, "root/.codex/models.json"), "utf8")
  assert.equal(installed, vendored)
  assert.equal((JSON.parse(installed) as { models: unknown[] }).models.length, 2)
  for (const f of ["root/.codex/config.toml", "root/.codex/AGENTS.md", "root/.codex/models.json"]) {
    assert.equal(fs.statSync(path.join(root, f)).mode & 0o777, 0o600, f)
  }
})
