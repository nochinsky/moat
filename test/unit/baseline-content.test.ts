import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { envPaths } from "../../lib/paths.ts"
import { copyIn, ensureSandboxRepo, recordBaseline } from "../../sync/copyin.ts"
import { applyPlan, planApply, planVerdict } from "../../sync/apply.ts"

/**
 * What the baseline holds decides whether the three-way comparison can tell your edits apart
 * from the agent's.
 *
 * `recordBaseline` used to `git add -A` and commit the result, so the baseline was the working
 * tree *with your uncommitted changes folded in*. That reads like "exactly what was copied" and
 * it silently broke the product's central claim on the most common state a repository is in:
 * `planApply` decides whether a file is yours by comparing the host against the baseline, and a
 * file you had already edited compared **equal** to a dirty baseline. The agent's version then
 * went over your work as a plain "update", with no conflict and nothing said, contradicting
 * SPEC §2.2.
 *
 * Measured before the fix: a file edited on the host before copy-in and rewritten by the agent
 * came back with your edit gone, reported as `applied 2 change(s); skipped 0`.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
}

/**
 * A temporary root with MOAT_HOME pointed inside it, so no test touches the real store.
 *
 * Callers resolve environment paths *after* this runs, because `envPaths` reads MOAT_HOME when it
 * is called: building them inside the fixture put the work tree one level off and these tests
 * failed with ENOENT for a directory that existed.
 */
function withTempHome(t: { after: (fn: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-baseline-"))
  const previousHome = process.env.MOAT_HOME
  process.env.MOAT_HOME = path.join(root, "moat-home")
  t.after(() => {
    if (previousHome === undefined) delete process.env.MOAT_HOME
    else process.env.MOAT_HOME = previousHome
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

/** A host project with `files` committed, in a temp home. Returns the project directory. */
function hostProject(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
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
  return host
}

test("the baseline is the commit, not the working tree with your uncommitted changes in it", async (t) => {
  const host = hostProject(t, {
    "notes.txt": "line one\nline two\nline three\n",
    "mine.txt": "committed\n",
  })
  // Your work in progress, after the commit: the ordinary state of a repository somebody is
  // working in, and the state this whole comparison has to survive.
  fs.writeFileSync(path.join(host, "notes.txt"), "line one\nMY UNCOMMITTED EDIT\nline three\n")
  fs.writeFileSync(path.join(host, "mine.txt"), "MY UNCOMMITTED EDIT TOO\n")

  // The real boot sequence, in the order `cmdUp` runs it: copy in, give a non-git project a
  // repository, then record the baseline. Calling `recordBaseline` alone would test something the
  // CLI never does, and using `copyIn` alone would find no baseline at all -- which is how the
  // first version of this test failed.
  const p = envPaths(host)
  await copyIn(p)
  await ensureSandboxRepo(p)
  assert.ok(await recordBaseline(p), "the boot records a baseline")

  assert.equal(git(p.work, "show", "refs/moat/baseline:notes.txt"), "line one\nline two\nline three\n", "the baseline is HEAD")
  assert.equal(git(p.work, "show", "refs/moat/baseline:mine.txt"), "committed\n")
  // The working tree still carries your edit: the agent has to see your work, and only what
  // counts as "before" changed.
  assert.equal(fs.readFileSync(path.join(p.work, "notes.txt"), "utf8"), "line one\nMY UNCOMMITTED EDIT\nline three\n")
  assert.match(git(p.work, "status", "--short"), /M notes\.txt/, "your edit travels as an uncommitted change")
})

test("a file you edited and the agent rewrote is a conflict, not a silent overwrite", async (t) => {
  // The end of the failure above, stated as the user's outcome: your line survives and the
  // agent's overlapping change is reported rather than written.
  const host = hostProject(t, {
    "notes.txt": "line one\nline two\nline three\n",
    "app.js": 'export const greeting = () => "Hello"\n',
  })
  fs.writeFileSync(path.join(host, "notes.txt"), "line one\nMY UNCOMMITTED EDIT\nline three\n")

  const p = envPaths(host)
  await copyIn(p)
  await ensureSandboxRepo(p)
  assert.ok(await recordBaseline(p), "the boot records a baseline")

  // The agent works in the sandbox: it rewrites the line you just changed, and changes a file
  // you did not touch.
  fs.writeFileSync(path.join(p.work, "notes.txt"), "line one\nAGENT REWROTE THIS\nline three\n")
  fs.writeFileSync(path.join(p.work, "app.js"), 'export const greeting = () => "Hi"\n')
  git(p.work, "add", "-A")
  git(p.work, "-c", "user.email=agent@example.com", "-c", "user.name=agent", "commit", "-qm", "agent: work")

  const plan = await planApply(p)
  const verdicts = planVerdict(plan)
  assert.deepEqual(
    verdicts.map((row) => `${row.path}=${row.verdict}`).sort(),
    ["app.js=agent", "notes.txt=conflict"],
    "the file only the agent touched is the agent's; the file you both touched is a conflict",
  )
  // Every verdict appears once. `plan.conflicts` is a subset of `plan.changes`, and walking both
  // listed each conflict twice in the demo's output.
  assert.equal(new Set(verdicts.map((row) => row.path)).size, verdicts.length)

  const result = await applyPlan(p, plan)
  assert.deepEqual(result.skipped, ["notes.txt"], "the conflict is not written")
  assert.equal(
    fs.readFileSync(path.join(host, "notes.txt"), "utf8"),
    "line one\nMY UNCOMMITTED EDIT\nline three\n",
    "your line is exactly as you left it",
  )
  assert.equal(
    fs.readFileSync(path.join(host, "app.js"), "utf8"),
    'export const greeting = () => "Hi"\n',
    "and the agent's non-overlapping change did land",
  )
})

test("a repository with no commits yet loses its working tree on copy-in, which is a known trap", async (t) => {
  // **This documents a real limitation, not a behaviour worth keeping.** `copy-in` on a git
  // project is `git clone --no-hardlinks`, and cloning a repository whose HEAD is unborn copies
  // the commits -- of which there are none -- and no working tree. So a project someone has
  // `git init`-ed, filled with files and not committed to arrives in the sandbox *empty*, with no
  // warning. Measured here rather than assumed:
  const root = withTempHome(t)
  const host = path.join(root, "project")
  fs.mkdirSync(host, { recursive: true })
  git(host, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(host, "a.txt"), "no commit yet\n")
  git(host, "add", "-A")

  const p = envPaths(host)
  await copyIn(p)
  assert.deepEqual(fs.readdirSync(p.work), [".git"], "the sandbox copy has the repository and none of the files")

  // The baseline recorded for that copy is the empty tree, which is the honest answer to "what
  // was this project before anyone touched it" when there is no commit. Both facts are asserted
  // so a future fix has to update this test deliberately rather than silently.
  await ensureSandboxRepo(p)
  const baseline = await recordBaseline(p)
  assert.ok(baseline)
  assert.equal(git(p.work, "ls-tree", "-r", "--name-only", baseline), "", "the baseline is empty")
  // If this trap is ever fixed (by committing, or by falling back to rsync when HEAD is unborn),
  // the first assertion above is the one that changes.
})

test("a sandbox with no repository has no baseline to record, and that is not an error", async (t) => {
  // `resolveGitDir` returns null for a work tree with no `.git`, and `recordBaseline` turns that
  // into a null rather than a thrown error: `moat up` on a plain directory has a real path after
  // this, but the helper has to be safe to call before the repository exists.
  const host = hostProject(t, { "plain.txt": "no repository here\n" })
  const p = envPaths(host)
  fs.mkdirSync(p.work, { recursive: true })
  assert.equal(await recordBaseline(p), null)
  // And `ensureSandboxRepo` gives a non-git project the repository it needs.
  await ensureSandboxRepo(p)
  assert.ok(await recordBaseline(p), "after ensureSandboxRepo a baseline exists")
})
