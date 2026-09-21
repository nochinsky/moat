import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { installCodexFiles } from "../../bundle/codex.ts"
import { CODEX_BUILTIN_PROMPT } from "../../bundle/codex-prompt.ts"
import { renderModelCatalog } from "../../bundle/model-catalog.ts"
import { renderInstructions } from "../../bundle/instructions.ts"

const CATALOG_MODEL = "deepseek-flash"

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
  installCodexFiles(root, { config, brief, catalog: renderModelCatalog({ model: CATALOG_MODEL }) })
  assert.equal(fs.readFileSync(path.join(root, "root/.codex/config.toml"), "utf8"), config)
  assert.equal(fs.readFileSync(path.join(root, "root/.codex/AGENTS.md"), "utf8"), brief)
  // The catalog is rendered per boot from the model being configured, and installed at the path
  // `renderCodexConfig` names in model_catalog_json. It used to be a vendored file copied in
  // byte-for-byte; the assertion that matters now is that what lands in the box is a catalog for
  // the model it was rendered from, with the pinned prompt and no vendor's metadata.
  const installed = fs.readFileSync(path.join(root, "root/.codex/models.json"), "utf8")
  const parsed = JSON.parse(installed) as { models: { slug: string; base_instructions: string }[] }
  assert.equal(parsed.models.length, 1)
  assert.equal(parsed.models[0]!.slug, CATALOG_MODEL)
  assert.equal(parsed.models[0]!.base_instructions, CODEX_BUILTIN_PROMPT)
  for (const f of ["root/.codex/config.toml", "root/.codex/AGENTS.md", "root/.codex/models.json"]) {
    assert.equal(fs.statSync(path.join(root, f)).mode & 0o777, 0o600, f)
  }
})
