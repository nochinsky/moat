import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { installPiFiles, renderPiFiles } from "../../bundle/pi.ts"
import { resolveModelFacts } from "../../lib/model-facts.ts"

function root(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moat-pi-files-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const facts = resolveModelFacts({ catalog: null, providerID: "acme", modelID: "model", providerIsNative: false })

test("a literal key refuses the entire set before writing anything", (t) => {
  const dir = root(t)
  const files = { ...renderPiFiles({ facts, providerID: "acme", baseURL: "https://acme.example/v1", envKey: "ACME_KEY" }), brief: "instructions" }
  assert.throws(() => installPiFiles(dir, { ...files, brief: "sk-proj-" + "A".repeat(40) }), /literal API key/)
  assert.deepEqual(fs.readdirSync(dir), [])
})

test("Pi settings, model and brief land at private paths, but no auth file or project instruction file does", (t) => {
  const dir = root(t)
  const files = { ...renderPiFiles({ facts, providerID: "acme", baseURL: "https://acme.example/v1", envKey: "ACME_KEY" }), brief: "instructions" }
  installPiFiles(dir, files)
  for (const [file, text] of [["settings.json", files.config], ["models.json", files.catalog], ["AGENTS.md", files.brief]]) {
    const target = path.join(dir, "root/.pi/agent", file!)
    assert.equal(fs.readFileSync(target, "utf8"), text)
    assert.equal(fs.statSync(target).mode & 0o777, 0o600)
  }
  assert.equal(fs.existsSync(path.join(dir, "root/.pi/agent/auth.json")), false)
  assert.equal(fs.existsSync(path.join(dir, "work/AGENTS.md")), false)
  assert.equal(fs.existsSync(path.join(dir, "root/.codex")), false)
})
