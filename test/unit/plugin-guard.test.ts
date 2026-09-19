import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { MoatBundle } from "../../bundle/plugin/moat-bundle.mjs"

const ROOT = path.join(os.tmpdir(), "moat-plugin-workspace")

async function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moat-plugin-"))
  const audit = path.join(dir, "tools.jsonl")
  process.env.MOAT_AUDIT_LOG = audit
  t.after(() => {
    delete process.env.MOAT_AUDIT_LOG
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const hooks = await MoatBundle({ worktree: ROOT, directory: ROOT, serverUrl: "" })
  return { hooks, audit }
}

test("the plugin refuses a permission rule that is not exactly allow-all", async (t) => {
  const { hooks } = await fixture(t)
  await assert.rejects(() => hooks.config!({ permission: { "*": "allow", bash: "ask" }, tools: {} }), /permission/)
  await assert.rejects(() => hooks.config!({ permission: {}, tools: {} }), /permission/)
  await hooks.config!({
    permission: { "*": "allow" },
    tools: { skill: false, webfetch: false, websearch: false, task: false },
  })
})

test("the plugin rejects a patch move out of the workspace and allows one inside it", async (t) => {
  const { hooks } = await fixture(t)
  const run = (patchText: string) =>
    hooks["tool.execute.before"]!({ tool: "apply_patch", sessionID: "s", callID: "c" }, { args: { patchText } })
  await assert.rejects(
    () => run("*** Begin Patch\n*** Update File: inside.txt\n*** Move to: /etc/passwd\n*** End Patch\n"),
    /outside the workspace/,
  )
  await run("*** Begin Patch\n*** Update File: inside.txt\n*** Move to: other.txt\n*** End Patch\n")
})

test("a completed call is recorded as completed, not as success", async (t) => {
  const { hooks, audit } = await fixture(t)
  await hooks["tool.execute.after"]!(
    { tool: "bash", sessionID: "s", callID: "c" },
    { title: "bash", output: "done" },
  )
  const lines = fs
    .readFileSync(audit, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const after = lines.find((line) => line.phase === "after")
  assert.ok(after, "the after hook must have written a record")
  assert.equal(after!.completed, true)
  assert.equal("ok" in after!, false, "the hook cannot attest success, so it must not claim it")
})
