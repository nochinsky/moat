import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { applyPlan, planApply, safeDestination } from "../../sync/apply.ts"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
}

type Fixture = {
  root: string
  host: string
  work: string
  p: never
}

function fixture(files: Record<string, string>): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-apply-"))
  const host = path.join(root, "host")
  const dir = path.join(root, "env")
  const work = path.join(dir, "rootfs", "work")
  fs.mkdirSync(host, { recursive: true })
  fs.mkdirSync(path.dirname(work), { recursive: true })
  git(host, "init", "-q")
  git(host, "config", "user.email", "a@b")
  git(host, "config", "user.name", "t")
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(host, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  git(host, "add", "-A")
  git(host, "commit", "-qm", "base")
  execFileSync("git", ["clone", "-q", host, work])
  git(work, "config", "user.email", "a@b")
  git(work, "config", "user.name", "t")
  git(work, "update-ref", "refs/moat/baseline", "HEAD")
  const p = {
    id: "t",
    projectDir: host,
    dir,
    rootfs: path.join(dir, "rootfs"),
    work,
    mountpoint: path.join(dir, "mnt"),
    state: path.join(dir, "state.json"),
    logs: "",
    snapshots: "",
    entryScript: "",
    auditDir: "",
  }
  return { root, host, work, p: p as never }
}

function cleanup(t: { after: (fn: () => void) => void }, f: Fixture): void {
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
}

test("two files merged cleanly each keep their own merge", (t) => {
  const f = fixture({ "f1.txt": "base1\n", "f2.txt": "base2\n" })
  cleanup(t, f)
  // The agent appends; the user prepends. Non-overlapping, so both merge.
  fs.writeFileSync(path.join(f.work, "f1.txt"), "base1\nagent1\n")
  fs.writeFileSync(path.join(f.work, "f2.txt"), "base2\nagent2\n")
  fs.writeFileSync(path.join(f.host, "f1.txt"), "user1\nbase1\n")
  fs.writeFileSync(path.join(f.host, "f2.txt"), "user2\nbase2\n")

  return (async () => {
    const plan = await planApply(f.p)
    assert.deepEqual(
      plan.changes.filter((c) => c.kind === "merge" && !c.conflict).map((c) => c.path).sort(),
      ["f1.txt", "f2.txt"],
    )
    const result = await applyPlan(f.p, plan)
    assert.equal(result.applied, 2)
    const one = fs.readFileSync(path.join(f.host, "f1.txt"), "utf8")
    const two = fs.readFileSync(path.join(f.host, "f2.txt"), "utf8")
    // Regression: a single shared merged.tmp made both files the last merge.
    assert.ok(one.includes("user1") && one.includes("agent1"), one)
    assert.ok(two.includes("user2") && two.includes("agent2"), two)
  })()
})

test("a filename with two spaces is not misattributed to another file", (t) => {
  const f = fixture({ "a b": "keep\n", "a  b": "two\n" })
  cleanup(t, f)
  fs.rmSync(path.join(f.work, "a  b"))

  return (async () => {
    const plan = await planApply(f.p)
    const deletions = plan.changes.filter((c) => c.kind === "delete" && !c.conflict)
    assert.deepEqual(deletions.map((c) => c.path), ["a  b"])
    await applyPlan(f.p, plan)
    assert.ok(fs.existsSync(path.join(f.host, "a b")), "the unrelated file must survive")
    assert.equal(fs.existsSync(path.join(f.host, "a  b")), false)
  })()
})

test("a file the user deleted and the agent changed is a conflict", (t) => {
  const f = fixture({ "keep.txt": "base\n" })
  cleanup(t, f)
  fs.writeFileSync(path.join(f.work, "keep.txt"), "agent changed\n")
  fs.rmSync(path.join(f.host, "keep.txt"))

  return (async () => {
    const plan = await planApply(f.p)
    const change = plan.changes.find((c) => c.path === "keep.txt")
    assert.ok(change, "the path must appear in the plan")
    assert.equal(change!.conflict, true)
    assert.match(change!.note ?? "", /deleted/)
    await applyPlan(f.p, plan)
    assert.equal(fs.existsSync(path.join(f.host, "keep.txt")), false, "the deletion must not be undone")
  })()
})

test("a mode-only change is planned and applied", (t) => {
  const f = fixture({ "mode.sh": "echo hi\n" })
  cleanup(t, f)
  fs.chmodSync(path.join(f.work, "mode.sh"), 0o755)

  return (async () => {
    const plan = await planApply(f.p)
    const change = plan.changes.find((c) => c.path === "mode.sh")
    assert.ok(change, "a chmod in the sandbox must not be dropped")
    assert.equal(change!.kind, "mode")
    await applyPlan(f.p, plan)
    assert.equal(fs.statSync(path.join(f.host, "mode.sh")).mode & 0o777, 0o755)
  })()
})

test("a missing baseline is reported, never rendered as 'nothing to apply'", (t) => {
  const f = fixture({ "a.txt": "base\n" })
  cleanup(t, f)
  fs.writeFileSync(path.join(f.work, "a.txt"), "agent\n")
  git(f.work, "update-ref", "-d", "refs/moat/baseline")

  return (async () => {
    const plan = await planApply(f.p)
    assert.ok(plan.baselineProblem, "the plan must carry a problem")
    assert.equal(plan.empty, true)
    assert.equal(fs.readFileSync(path.join(f.host, "a.txt"), "utf8"), "base\n")
  })()
})

test("an edit made after the plan is shown is not overwritten", (t) => {
  const f = fixture({ "a.txt": "base\n" })
  cleanup(t, f)
  fs.writeFileSync(path.join(f.work, "a.txt"), "agent\n")

  return (async () => {
    const plan = await planApply(f.p)
    // The user edits the file while reading the plan.
    fs.writeFileSync(path.join(f.host, "a.txt"), "user typed this\n")
    const result = await applyPlan(f.p, plan)
    assert.equal(result.applied, 0)
    assert.deepEqual(result.skipped, ["a.txt"])
    assert.equal(fs.readFileSync(path.join(f.host, "a.txt"), "utf8"), "user typed this\n")
  })()
})

test("a destination outside the project is refused, including through a symlink", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-safe-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const project = path.join(root, "project")
  const outside = path.join(root, "outside")
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.symlinkSync(outside, path.join(project, "escape"))
  assert.equal(safeDestination(project, "../outside/x"), null)
  assert.equal(safeDestination(project, "escape/x"), null)
  assert.equal(safeDestination(project, "fine/x"), path.join(project, "fine", "x"))
})

test("a new file the agent created is applied", (t) => {
  const f = fixture({ "keep.txt": "base\n" })
  cleanup(t, f)
  fs.writeFileSync(path.join(f.work, "agent-output.txt"), "hello\n")

  return (async () => {
    const plan = await planApply(f.p)
    const change = plan.changes.find((c) => c.path === "agent-output.txt")
    assert.ok(change, "the new file must be in the plan")
    assert.equal(change!.kind, "add")
    const result = await applyPlan(f.p, plan)
    assert.equal(result.applied, 1)
    assert.equal(fs.readFileSync(path.join(f.host, "agent-output.txt"), "utf8"), "hello\n")
  })()
})

test("a new symlink the agent created is applied as a symlink", (t) => {
  const f = fixture({ "keep.txt": "base\n" })
  cleanup(t, f)
  fs.symlinkSync("keep.txt", path.join(f.work, "link.txt"))

  return (async () => {
    const plan = await planApply(f.p)
    const change = plan.changes.find((c) => c.path === "link.txt")
    assert.ok(change, "the symlink must be in the plan")
    assert.equal(change!.kind, "link")
    await applyPlan(f.p, plan)
    assert.equal(fs.readlinkSync(path.join(f.host, "link.txt")), "keep.txt")
  })()
})

test("a second plan does not invalidate the first plan's merge inputs", async (t) => {
  // The bug: merge temps were named by path alone (moat-merge-<hash>.tmp) and
  // every planApply() deleted every temp it could find. So a plan made while
  // another apply was in flight lost its merged inputs under it — applyPlan then
  // skipped the change silently — and two concurrent plans shared one temp file,
  // the same shape as the fixed state.json.tmp.
  const f = fixture({ "shared.txt": "base\n" })
  cleanup(t, f)
  fs.writeFileSync(path.join(f.work, "shared.txt"), "base\nagent\n")
  fs.writeFileSync(path.join(f.host, "shared.txt"), "user\nbase\n")

  const first = await planApply(f.p)
  const firstMerge = first.changes.find((c) => c.kind === "merge")
  assert.ok(firstMerge?.mergedFile, "the fixture must produce a merge")

  // A second plan runs while the first is still waiting to be applied.
  const second = await planApply(f.p)
  const secondMerge = second.changes.find((c) => c.kind === "merge")
  assert.ok(secondMerge?.mergedFile, "the second plan must merge too")
  assert.equal(fs.existsSync(firstMerge!.mergedFile!), true, "the second plan deleted the first plan's input")
  assert.notEqual(secondMerge!.mergedFile, firstMerge!.mergedFile, "temp names must be unique per call")

  const result = await applyPlan(f.p, first)
  assert.equal(result.skipped.includes("shared.txt"), false, "the merge must still be applicable")
  const merged = fs.readFileSync(path.join(f.host, "shared.txt"), "utf8")
  assert.match(merged, /agent/)
  assert.match(merged, /user/)
})

test("apply writes the bytes that were planned, not whatever is in the sandbox now", async (t) => {
  // `applyPlan` used to read `<sandbox>/<path>` at write time, after the plan was
  // shown and after the credential scan had looked at the file. Two problems in one
  // read: what was scanned and what was written could differ, and the sandbox path is
  // agent-controlled, so a symlink swapped in between planning and applying pulled a
  // *host* file into the project — a host file travelling out of the host, which is
  // the one direction this tool exists to prevent.
  const f = fixture({ "notes.txt": "base\n" })
  cleanup(t, f)
  const outside = path.join(f.root, "outside-secret.txt")
  fs.writeFileSync(outside, "the host's own file\n")
  fs.writeFileSync(path.join(f.work, "notes.txt"), "what the agent wrote\n")

  const plan = await planApply(f.p)
  const change = plan.changes.find((c) => c.path === "notes.txt")
  assert.ok(change, "the plan must contain notes.txt")

  // Between the plan and the apply: the agent replaces its file with a symlink to a
  // host path, which is exactly what an agent that read /proc/self/mountinfo can do.
  fs.rmSync(path.join(f.work, "notes.txt"))
  fs.symlinkSync(outside, path.join(f.work, "notes.txt"))

  const result = await applyPlan(f.p, plan)
  assert.deepEqual(result.skipped, [])
  assert.equal(
    fs.readFileSync(path.join(f.host, "notes.txt"), "utf8"),
    "what the agent wrote\n",
    "the planned bytes land, not the symlink's target",
  )
  assert.equal(fs.readFileSync(outside, "utf8"), "the host's own file\n", "and the host file is untouched")
  assert.equal(fs.lstatSync(path.join(f.host, "notes.txt")).isSymbolicLink(), false)
})

test("the frozen source is a host-side file, and a plan can be applied after another is made", async (t) => {
  // The frozen copy has to live outside the rootfs the agent owns, and it has to
  // survive a second plan: names are unique per call, so two plans do not take each
  // other's inputs (the same trap the merge temps had).
  const f = fixture({ "a.txt": "base\n" })
  cleanup(t, f)
  fs.writeFileSync(path.join(f.work, "a.txt"), "from the agent\n")
  const first = await planApply(f.p)
  const second = await planApply(f.p)
  const firstSource = first.changes.find((c) => c.path === "a.txt")?.sourceFile
  const secondSource = second.changes.find((c) => c.path === "a.txt")?.sourceFile
  assert.ok(firstSource && secondSource)
  assert.notEqual(firstSource, secondSource, "temp names are unique per call")
  for (const source of [firstSource!, secondSource!]) {
    assert.equal(fs.existsSync(source), true)
    const rootfs = path.join(f.root, "env", "rootfs")
    assert.equal(source.startsWith(rootfs), false, "the frozen bytes live outside the sandbox rootfs")
  }
  await applyPlan(f.p, first)
  assert.equal(fs.readFileSync(path.join(f.host, "a.txt"), "utf8"), "from the agent\n")
})
