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

test("the plugin accepts the merged config opencode actually hands it", async (t) => {
  // The bug, visible in every boot log: opencode compiles `tools: {name: false}`
  // into `permission: {name: "deny"}` before this hook runs. The old
  // "exactly {*: allow}" check therefore threw on every boot; opencode logs a
  // plugin hook error and ignores it, so the in-box invariant re-check, the
  // curation assertion and the audit config record silently never happened.
  const { hooks, audit } = await fixture(t)
  await hooks.config!({
    permission: { skill: "deny", webfetch: "deny", websearch: "deny", task: "deny", "*": "allow" },
    tools: { skill: false, webfetch: false, websearch: false, task: false },
  })
  // Upstream folds these three names into one `edit` rule. The curation
  // assertion is a second, independent check, so the declared omissions stay.
  await hooks.config!({
    permission: { edit: "deny", "*": "allow" },
    tools: { skill: false, webfetch: false, websearch: false, task: false, write: false },
  })

  const lines = fs
    .readFileSync(audit, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const configs = lines.filter((line) => line.phase === "config")
  assert.equal(configs.length, 2, "a passing check must leave the config record the evidence quotes")
  assert.deepEqual(configs[0]!.permission, {
    skill: "deny",
    webfetch: "deny",
    websearch: "deny",
    task: "deny",
    "*": "allow",
  })
  assert.deepEqual(configs[0]!.toolOmissions, ["skill", "webfetch", "websearch", "task"])
  assert.deepEqual(configs[0]!.curationGaps, [])
})

test("the plugin still refuses an approval rule, or a deny moat did not ask for", async (t) => {
  const { hooks } = await fixture(t)
  const omissions = { skill: false, webfetch: false, websearch: false, task: false }
  await assert.rejects(
    () => hooks.config!({ permission: { "*": "allow", bash: "ask" }, tools: omissions }),
    /refusing to run with permission/,
  )
  await assert.rejects(() => hooks.config!({ permission: {}, tools: omissions }), /refusing to run with permission/)
  // A tool denied that moat did not curate out is a tool silently missing.
  await assert.rejects(
    () => hooks.config!({ permission: { "*": "allow", bash: "deny" }, tools: omissions }),
    /refusing to run with permission/,
  )
  await assert.rejects(
    () => hooks.config!({ permission: { webfetch: "deny", "*": "allow" }, tools: { bash: false } }),
    /refusing to run with permission/,
  )
  // And the curation assertion is still its own failure, not a permission one.
  await assert.rejects(() => hooks.config!({ permission: { "*": "allow" }, tools: {} }), /not curating/)
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
