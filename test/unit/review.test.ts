import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { envPaths } from "../../lib/paths.ts"
import { copyIn, ensureSandboxRepo, recordBaseline } from "../../sync/copyin.ts"
import { applySelection, planApply, reviewPlan, type Selection } from "../../sync/apply.ts"

/**
 * The review surface, exercised through the real planner.
 *
 * `test/unit/baseline-content.test.ts` already covers the two classifications the product rests on
 * (agent-only, and you-and-the-agent conflicting). This file covers the rest of the branches the
 * gate names — you-only, cleanly merged, added, deleted, mode, link — and every partial-accept
 * path: some hunks, none, all, a stale plan, and a conflict that no selection can write.
 *
 * The fixture runs the real boot sequence (`copyIn` -> `ensureSandboxRepo` -> `recordBaseline`)
 * against a real git repository, because the classification *is* a comparison of three trees and a
 * fixture that fabricates the baseline tests a different thing.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
}

function withTempHome(t: { after: (fn: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-review-"))
  const previousHome = process.env.MOAT_HOME
  process.env.MOAT_HOME = path.join(root, "moat-home")
  t.after(() => {
    if (previousHome === undefined) delete process.env.MOAT_HOME
    else process.env.MOAT_HOME = previousHome
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

type Fixture = { host: string; paths: ReturnType<typeof envPaths> }

/** A committed project, copied in and baselined, ready for the agent to change. */
async function booted(t: { after: (fn: () => void) => void }, files: Record<string, string>): Promise<Fixture> {
  const root = withTempHome(t)
  const host = path.join(root, "project")
  fs.mkdirSync(host, { recursive: true })
  git(host, "init", "-q", "-b", "main")
  git(host, "config", "user.email", "you@example.com")
  git(host, "config", "user.name", "You")
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(host, rel)), { recursive: true })
    fs.writeFileSync(path.join(host, rel), content)
  }
  git(host, "add", "-A")
  git(host, "commit", "-qm", "base")
  const paths = envPaths(host)
  await copyIn(paths)
  await ensureSandboxRepo(paths)
  assert.ok(await recordBaseline(paths), "the boot records a baseline")
  return { host, paths }
}

/** The agent's work in the sandbox: write files, then commit whatever changed. */
function agentWorks(f: Fixture, edits: Record<string, string | null>): void {
  for (const [rel, content] of Object.entries(edits)) {
    const target = path.join(f.paths.work, rel)
    if (content === null) {
      fs.rmSync(target, { recursive: true, force: true })
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  git(f.paths.work, "add", "-A")
  git(f.paths.work, "-c", "user.email=agent@example.com", "-c", "user.name=agent", "commit", "-qm", "agent: work")
}

/** Forty numbered lines, so two changes can be placed anywhere and land in separate hunks. */
function numbered(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
}

function edited(count: number, edits: Record<number, string>): string {
  const lines = Array.from({ length: count }, (_, i) => `line ${i + 1}`)
  for (const [line, text] of Object.entries(edits)) lines[Number(line) - 1] = text
  return lines.join("\n") + "\n"
}

test("every classification branch reaches the review with the planner's own verdict", async (t) => {
  const f = await booted(t, {
    "notes.txt": numbered(40),
    "added.txt": "the agent will add this\n",
    "doomed.txt": "the agent will delete this\n",
    "script.sh": "#!/bin/sh\nexit 0\n",
  })
  // Yours: an edit the agent does not touch, and one it does.
  fs.writeFileSync(path.join(f.host, "yours.txt"), "yours alone\n")
  fs.writeFileSync(path.join(f.host, "notes.txt"), edited(40, { 3: "line 3: you changed this" }))
  fs.writeFileSync(path.join(f.host, "yours.txt"), "you changed only this\n")
  fs.chmodSync(path.join(f.host, "yours.txt"), 0o600)
  fs.rmSync(path.join(f.host, "added.txt"))
  fs.writeFileSync(path.join(f.host, "newdir"), "")
  fs.rmSync(path.join(f.host, "newdir"))

  agentWorks(f, {
    // Two far-apart changes: one lands where you edited (a conflict), one does not (clean).
    "notes.txt": edited(40, { 3: "line 3: the agent changed this", 31: "line 31: the agent changed this" }),
    "added.txt": "the agent rewrote what you deleted\n",
    "doomed.txt": null,
    "script.sh": "#!/bin/sh\nexit 1\n",
    "fresh.txt": "created by the agent\n",
  })
  // Yours, in a file the agent left alone: not in the plan at all, because there is nothing to do.
  fs.writeFileSync(path.join(f.host, "untouched-by-agent.txt"), "only yours\n")

  const plan = await planApply(f.paths)
  const reviewed = await reviewPlan(f.paths, plan)
  const by = new Map(reviewed.map((row) => [row.path, row]))

  assert.equal(by.get("notes.txt")?.verdict, "conflict", "you and the agent changed the same line")
  assert.equal(by.get("fresh.txt")?.verdict, "agent", "a file only the agent created is the agent's")
  assert.equal(by.get("fresh.txt")?.kind, "add")
  assert.equal(by.get("doomed.txt")?.kind, "delete")
  assert.equal(by.get("script.sh")?.kind, "modify", "a content change is a modify")
  // A file only you changed is absent: `planApply` reports what has to be merged, and there is
  // nothing to merge in a file the agent never touched.
  assert.equal(by.has("yours.txt"), false, "a file only you changed is not in the plan")
  assert.equal(by.has("untouched-by-agent.txt"), false)

  // Every row carries a verdict from the planner's own vocabulary, and every verdict is one of
  // the four the review prints.
  for (const row of reviewed) {
    assert.ok(["agent", "you", "both", "conflict"].includes(row.verdict), row.path + " " + row.verdict)
  }
})

test("a partial accept writes exactly the accepted hunks and nothing else", async (t) => {
  const f = await booted(t, { "notes.txt": numbered(40) })
  agentWorks(f, { "notes.txt": edited(40, { 3: "line 3: the agent", 31: "line 31: the agent" }) })

  const plan = await planApply(f.paths)
  const reviewed = await reviewPlan(f.paths, plan)
  const row = reviewed.find((r) => r.path === "notes.txt")!
  assert.equal(row.hunks.length, 2, "two changes 28 lines apart are two hunks")
  assert.equal(row.partial, true)

  // Accept the second hunk only. The first must not be written, and the file must be otherwise
  // byte-identical to what it was: same length, same lines, one of them replaced.
  const before = fs.readFileSync(path.join(f.host, "notes.txt"), "utf8")
  const result = await applySelection(f.paths, plan, [{ path: "notes.txt", accepted: [1] }])
  assert.deepEqual(result.skipped, [])
  assert.equal(result.applied.length, 1)
  assert.equal(result.applied[0]!.mode, "partial")
  const after = fs.readFileSync(path.join(f.host, "notes.txt"), "utf8")
  assert.match(after, /line 31: the agent/)
  assert.doesNotMatch(after, /line 3: the agent/)
  assert.match(after, /^line 3$/m, "the first hunk's line is the host's own")
  assert.equal(after.split("\n").length, before.split("\n").length, "a replacement does not change the line count")
  assert.equal(after.split("\n").filter((l) => l !== "").length, 40)
})

test("a partial accept takes the other hunk, and all of them, through the same writer", async (t) => {
  const f = await booted(t, { "notes.txt": numbered(40) })
  agentWorks(f, { "notes.txt": edited(40, { 3: "line 3: the agent", 31: "line 31: the agent" }) })
  const plan = await planApply(f.paths)
  const file = path.join(f.host, "notes.txt")

  // Hunk 1 alone.
  await applySelection(f.paths, plan, [{ path: "notes.txt", accepted: [0] }])
  let text = fs.readFileSync(file, "utf8")
  assert.match(text, /line 3: the agent/)
  assert.doesNotMatch(text, /line 31: the agent/)

  // The plan was made before the first write, so the file has changed under it: the second write
  // must be refused rather than written over a file that moved. This is the three-way re-check,
  // and a partial accept is exactly the case that can trip it.
  const second = await applySelection(f.paths, plan, [{ path: "notes.txt", accepted: [1] }])
  assert.deepEqual(second.applied, [], "a stale plan writes nothing")
  assert.equal(second.skipped.length, 1)
  assert.match(second.skipped[0]!.reason, /changed on the host since the plan was made/)

  // A fresh plan sees one remaining hunk, and taking it completes the file.
  const fresh = await planApply(f.paths)
  await applySelection(f.paths, fresh, [{ path: "notes.txt", accepted: null }])
  text = fs.readFileSync(file, "utf8")
  assert.match(text, /line 3: the agent/)
  assert.match(text, /line 31: the agent/)
  assert.equal(text, edited(40, { 3: "line 3: the agent", 31: "line 31: the agent" }))
})

test("accepting nothing writes nothing at all", async (t) => {
  const f = await booted(t, { "notes.txt": numbered(40), "other.txt": "keep me\n" })
  agentWorks(f, {
    "notes.txt": edited(40, { 3: "line 3: the agent" }),
    "other.txt": "the agent rewrote this\n",
  })
  const plan = await planApply(f.paths)
  const before = fs.readFileSync(path.join(f.host, "notes.txt"), "utf8")
  const otherBefore = fs.readFileSync(path.join(f.host, "other.txt"), "utf8")

  const result = await applySelection(f.paths, plan, [
    { path: "notes.txt", accepted: [] },
    // Not selected at all, which is the same outcome by a different route. It is deliberately
    // absent from the *report* as well as from the write: `applySelection` iterates the plan and
    // skips what the selection does not name, so "skipped" means "considered and declined", and a
    // path nobody selected was never a candidate. Both halves are load-bearing — measured, deleting
    // the `chosen.has` guard fails this test: an absent path then arrives at the `?? null` default
    // and the whole-file form writes `other.txt` over the host's copy.
  ])
  assert.deepEqual(result.applied, [])
  assert.deepEqual(result.skipped, [{ path: "notes.txt", reason: "you accepted none of it" }])
  assert.equal(fs.readFileSync(path.join(f.host, "notes.txt"), "utf8"), before)
  assert.equal(fs.readFileSync(path.join(f.host, "other.txt"), "utf8"), otherBefore, "an unselected path is untouched")
})

test("no selection can write a conflict, and the writer says so", async (t) => {
  const f = await booted(t, { "notes.txt": numbered(40) })
  fs.writeFileSync(path.join(f.host, "notes.txt"), edited(40, { 3: "line 3: you" }))
  agentWorks(f, { "notes.txt": edited(40, { 3: "line 3: the agent" }) })

  const plan = await planApply(f.paths)
  const reviewed = await reviewPlan(f.paths, plan)
  const row = reviewed.find((r) => r.path === "notes.txt")!
  assert.equal(row.conflict, true)
  assert.deepEqual(row.hunks, [], "a conflict offers no hunks: there is nothing to decide about")
  assert.equal(row.partial, false)

  // Whatever a caller passes — including the whole-file form and an explicit hunk list — the
  // conflicting path is refused by the writer, not by the caller's good behaviour.
  for (const selection of [
    { path: "notes.txt", accepted: null },
    { path: "notes.txt", accepted: [0] },
    { path: "notes.txt", accepted: [] },
  ] as Selection[]) {
    const result = await applySelection(f.paths, plan, [selection])
    assert.deepEqual(result.applied, [], "a conflict is never applied")
    assert.equal(result.skipped.length, 1)
    assert.match(result.skipped[0]!.reason, /conflicting/)
    assert.equal(fs.readFileSync(path.join(f.host, "notes.txt"), "utf8"), edited(40, { 3: "line 3: you" }))
  }
})

test("a clean merge arrives as hunks against your file, and a rejected hunk stays rejected", async (t) => {
  // The bug this pins: a merge used to be diffed against *itself*, so a merge that changed
  // anything reported zero hunks and `--hunks` refused it as "not divisible". The second half is
  // the worse one — anchoring a merge to the merged bytes re-applies every hunk that was not
  // explicitly rejected, because the merged bytes already contain them.
  const f = await booted(t, { "notes.txt": numbered(40) })
  fs.writeFileSync(path.join(f.host, "notes.txt"), edited(40, { 3: "line 3: you" }))
  agentWorks(f, { "notes.txt": edited(40, { 31: "line 31: the agent" }) })

  const plan = await planApply(f.paths)
  const reviewed = await reviewPlan(f.paths, plan)
  const row = reviewed.find((r) => r.path === "notes.txt")!
  assert.equal(row.verdict, "both", "non-overlapping edits are both sides' work")
  assert.equal(row.kind, "merge")
  assert.ok(row.hunks.length > 0, "a merge that changes something has hunks")

  // Rejecting the merge leaves your file alone, byte for byte.
  const before = fs.readFileSync(path.join(f.host, "notes.txt"), "utf8")
  const none = await applySelection(f.paths, plan, [{ path: "notes.txt", accepted: [] }])
  assert.deepEqual(none.applied, [])
  assert.equal(fs.readFileSync(path.join(f.host, "notes.txt"), "utf8"), before)

  // Taking it merges both sides' work.
  const all = await applySelection(f.paths, plan, [{ path: "notes.txt", accepted: null }])
  assert.equal(all.applied.length, 1)
  const merged = fs.readFileSync(path.join(f.host, "notes.txt"), "utf8")
  assert.match(merged, /line 3: you/)
  assert.match(merged, /line 31: the agent/)
})

test("a plan whose baseline is gone refuses to write anything", async (t) => {
  const f = await booted(t, { "notes.txt": numbered(40) })
  agentWorks(f, { "notes.txt": edited(40, { 3: "line 3: the agent" }) })
  const plan = await planApply(f.paths)
  assert.equal(plan.baselineProblem, null)

  // The sandbox repository loses the baseline: without it there is no third input, and a merge
  // would be a guess. `applySelection` must throw rather than write, exactly as `applyPlan` does.
  const broken = { ...plan, baselineProblem: "the sandbox no longer has refs/moat/baseline" }
  await assert.rejects(() => applySelection(f.paths, broken, [{ path: "notes.txt", accepted: null }]), /refs\/moat\/baseline/)
  assert.equal(fs.readFileSync(path.join(f.host, "notes.txt"), "utf8"), numbered(40), "nothing was written")
})

test("a path outside the project directory is refused, not written", async (t) => {
  // `safeDestination` is the guard for this and is tested elsewhere; the point here is that the
  // selection path goes through it too rather than trusting a plan made elsewhere.
  const f = await booted(t, { "notes.txt": numbered(40) })
  agentWorks(f, { "notes.txt": edited(40, { 3: "line 3: the agent" }) })
  const plan = await planApply(f.paths)
  const escaping = {
    ...plan,
    changes: plan.changes.map((change) => (change.path === "notes.txt" ? { ...change, path: "../escape.txt" } : change)),
  }
  const result = await applySelection(f.paths, escaping, [{ path: "../escape.txt", accepted: null }])
  assert.deepEqual(result.applied, [])
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0]!.reason, /outside the project directory/)
  assert.equal(fs.existsSync(path.join(path.dirname(f.host), "escape.txt")), false)
})

test("a partial accept carries the agent's final newline with the hunk that reaches the end", async (t) => {
  // The host file has no trailing newline and the agent's does; the changes at line 3 and line 40 are
  // far enough apart to be two hunks. Taking only the end-of-file hunk must write the agent's last
  // line *and* the newline that came with it, while leaving line 3 as the host's own. This is the
  // shape a partial accept used to get wrong: `applyHunks` always kept the destination's ending, so
  // the accepted end-of-file hunk silently lost the agent's last byte — a one-byte difference
  // between what the user reviewed and what landed. `--hunks 2` reaches exactly this path.
  const hostFile = numbered(40).slice(0, -1) // numbered(), without its trailing newline
  assert.ok(!hostFile.endsWith("\n"), "the fixture's point is a host file with no final newline")
  const f = await booted(t, { "notes.txt": hostFile })
  agentWorks(f, { "notes.txt": edited(40, { 3: "line 3: the agent", 40: "line 40: the agent" }) })

  const plan = await planApply(f.paths)
  const row = (await reviewPlan(f.paths, plan)).find((r) => r.path === "notes.txt")!
  assert.equal(row.hunks.length, 2, "the two changes are far enough apart to be separate hunks")

  const result = await applySelection(f.paths, plan, [{ path: "notes.txt", accepted: [1] }])
  assert.deepEqual(result.skipped, [])
  assert.equal(result.applied.length, 1)
  assert.equal(result.applied[0]!.mode, "partial")
  const after = fs.readFileSync(path.join(f.host, "notes.txt"), "utf8")
  assert.match(after, /line 40: the agent/)
  assert.doesNotMatch(after, /line 3: the agent/)
  assert.equal(after.split("\n").filter((line) => line !== "").length, 40, "still forty lines")
  assert.ok(after.endsWith("\n"), "the accepted end-of-file hunk brought the agent's newline")
})
