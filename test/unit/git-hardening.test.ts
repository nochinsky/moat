import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { SANITIZED_GIT_ENV, safeConfigFor, sandboxGit } from "../../lib/git.ts"
import { run } from "../../lib/shell.ts"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
}

function makeRepo(): { root: string; repo: string; marker: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-hard-"))
  const repo = path.join(root, "repo")
  fs.mkdirSync(repo, { recursive: true })
  git(repo, "init", "-q")
  git(repo, "config", "user.email", "a@b")
  git(repo, "config", "user.name", "t")
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", "base")
  return { root, repo, marker: path.join(root, "PWNED") }
}

function plantScript(file: string, marker: string): void {
  fs.writeFileSync(file, "#!/bin/sh\necho ran >> " + marker + "\n")
  fs.chmodSync(file, 0o755)
}

test("a repo-configured fsmonitor does not run on the host", (t) => {
  const f = makeRepo()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  plantScript(path.join(f.repo, "evil.sh"), f.marker)
  git(f.repo, "config", "core.fsmonitor", "./evil.sh")

  // Control: plain git does execute it, so this test is capable of failing.
  execFileSync("git", ["-C", f.repo, "status", "--porcelain"])
  assert.ok(fs.existsSync(f.marker), "control: plain git should have executed the fsmonitor")
  fs.rmSync(f.marker, { force: true })

  return (async () => {
    const result = await sandboxGit(f.repo, ["status", "--porcelain"])
    assert.equal(result.code, 0)
    assert.equal(fs.existsSync(f.marker), false, "hardened git must not execute the fsmonitor")
    assert.equal(git(f.repo, "config", "core.fsmonitor").trim(), "./evil.sh", "the agent's config must be restored")
  })()
})

test("a pre-commit hook written in the sandbox does not run on the host", (t) => {
  const f = makeRepo()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const hooks = path.join(f.repo, ".git", "hooks")
  fs.mkdirSync(hooks, { recursive: true })
  plantScript(path.join(hooks, "pre-commit"), f.marker)

  // Control.
  fs.writeFileSync(path.join(f.repo, "b.txt"), "b\n")
  execFileSync("git", ["-C", f.repo, "add", "-A"])
  execFileSync("git", ["-C", f.repo, "commit", "-qm", "plain"])
  assert.ok(fs.existsSync(f.marker), "control: plain commit should have run the hook")
  fs.rmSync(f.marker, { force: true })

  return (async () => {
    fs.writeFileSync(path.join(f.repo, "c.txt"), "c\n")
    await sandboxGit(f.repo, ["add", "-A"])
    // The sanitized config drops user.* like everything else, so the identity is
    // passed explicitly — exactly as moat's own commit paths do.
    const commit = await sandboxGit(f.repo, ["commit", "--quiet", "-m", "hardened"], {
      allowFailure: true,
      env: {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "a@b",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "a@b",
      },
    })
    assert.equal(commit.code, 0)
    assert.equal(fs.existsSync(f.marker), false, "hardened git must not run the agent's hook")
  })()
})

test("a clean filter configured in the repo does not run on the host", (t) => {
  const f = makeRepo()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  plantScript(path.join(f.repo, "filter.sh"), f.marker)
  fs.writeFileSync(path.join(f.repo, ".gitattributes"), "*.txt filter=evil\n")
  git(f.repo, "config", "filter.evil.clean", "./filter.sh")

  return (async () => {
    fs.writeFileSync(path.join(f.repo, "a.txt"), "changed\n")
    const result = await sandboxGit(f.repo, ["status", "--porcelain"])
    assert.equal(result.code, 0)
    assert.equal(fs.existsSync(f.marker), false, "hardened git must not run the agent's filter")
  })()
})

test("sandboxGit refuses a .git file that points outside the workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-gitfile-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const elsewhere = path.join(root, "elsewhere")
  const work = path.join(root, "work")
  fs.mkdirSync(elsewhere, { recursive: true })
  fs.mkdirSync(work, { recursive: true })
  fs.writeFileSync(path.join(work, ".git"), "gitdir: " + elsewhere + "\n")
  return (async () => {
    await assert.rejects(() => sandboxGit(work, ["status"]), /refusing to run host git/)
  })()
})

test("the sanitized config keeps only the repository-format keys", (t) => {
  const f = makeRepo()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  git(f.repo, "config", "core.fsmonitor", "./evil.sh")
  git(f.repo, "config", "filter.evil.clean", "./evil.sh")
  git(f.repo, "config", "alias.status", "!echo pwned")
  // The per-worktree config file is a second place to hide the same keys, and git
  // only reads it while `extensions.worktreeConfig` is set. Dropping that extension
  // is what keeps `.git/config.worktree` inert; preserving it "to be faithful to the
  // repository" would quietly reopen the gpg vector below. Measured: with the
  // extension dropped, a `config.worktree` holding log.showSignature + gpg.program
  // does not run the program through sandboxGit.
  git(f.repo, "config", "extensions.worktreeConfig", "true")
  git(f.repo, "config", "--worktree", "log.showSignature", "true")
  git(f.repo, "config", "--worktree", "gpg.program", "./evil.sh")
  const safe = safeConfigFor(path.join(f.repo, ".git"))
  assert.equal(safe.includes("fsmonitor"), false)
  assert.equal(safe.includes("filter"), false)
  assert.equal(safe.includes("alias"), false)
  assert.equal(safe.includes("worktreeconfig"), false, "the worktree config extension must be dropped")
  assert.match(safe, /repositoryformatversion = 0/)
})
/** A commit carrying a bogus signature header, so git tries to verify it. */
function signedCommit(repo: string): string {
  const raw = execFileSync("git", ["-C", repo, "cat-file", "commit", "HEAD"], { encoding: "utf8" })
  const [head = "", ...body] = raw.split("\n\n")
  const lines = head.split("\n")
  lines.push("gpgsig -----BEGIN PGP SIGNATURE-----")
  lines.push(" ")
  lines.push("iQEcBAABCAAGBQJ" + "A".repeat(60))
  lines.push(" -----END PGP SIGNATURE-----")
  const crafted = `${lines.join("\n")}\n\n${body.join("\n\n")}`
  return execFileSync("git", ["-C", repo, "hash-object", "-t", "commit", "-w", "--stdin"], {
    encoding: "utf8",
    input: crafted,
  }).trim()
}

/**
 * A repository the agent could leave behind: a script it wrote, a commit carrying a
 * bogus signature header, and (added by each caller) the config keys that make git run
 * that script from a plain `git log`.
 */
function hostileRepo(t: { after: (fn: () => void) => void }): { repo: string; marker: string; base: string; gpg: string } {
  const f = makeRepo()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const base = git(f.repo, "rev-parse", "--abbrev-ref", "HEAD").trim()
  git(f.repo, "checkout", "-q", "-b", "agent")
  fs.writeFileSync(path.join(f.repo, "b.txt"), "b\n")
  git(f.repo, "add", "-A")
  git(f.repo, "commit", "-qm", "agent change")
  git(f.repo, "update-ref", "refs/heads/agent", signedCommit(f.repo))
  const gpg = path.join(f.repo, "gpg.sh")
  plantScript(gpg, f.marker)
  return { repo: f.repo, marker: f.marker, base, gpg }
}

test("a signed commit plus log.showSignature does not run the agent's gpg on the host", (t) => {
  // The bug, measured: `/diff` in the REPL called `run("git", ["-C", work, "log", ...])`
  // directly. The global config was nulled, but the *repository* config belongs to the
  // agent, and git obeys `log.showSignature` from it: on a commit with any `gpgsig`
  // header, git runs `gpg.program` — which the agent can point at a script it wrote
  // into /work, whose host path it reads out of /proc/self/mountinfo — as the host user.
  // `/diff` was the one host-side git call left outside `sandboxGit`.
  const { repo, marker, base, gpg } = hostileRepo(t)
  git(repo, "config", "log.showSignature", "true")
  git(repo, "config", "gpg.program", gpg)

  return (async () => {
    // Control: the shape `/diff` used. It runs the agent's program, so this test is
    // capable of failing.
    const raw = await run("git", ["-C", repo, "log", "--oneline", `${base}..agent`], {
      env: SANITIZED_GIT_ENV,
      allowFailure: true,
    })
    assert.equal(raw.code, 0)
    assert.ok(fs.existsSync(marker), "control: the raw call runs the agent's gpg")
    fs.rmSync(marker, { force: true })

    const hardened = await sandboxGit(repo, ["log", "--oneline", `${base}..agent`], { allowFailure: true })
    assert.equal(hardened.code, 0)
    assert.match(hardened.stdout, /agent change/, "the log still renders")
    assert.equal(fs.existsSync(marker), false, "hardened git must not run the agent's gpg")
    // ...and the agent's own config is put back afterwards, so its repository is
    // untouched by moat looking at it.
    assert.equal(git(repo, "config", "log.showSignature").trim(), "true")
    assert.equal(git(repo, "config", "gpg.program").trim(), gpg)
  })()
})

test("a per-worktree config file cannot re-enable the execution keys", (t) => {
  // git reads .git/config.worktree only while `extensions.worktreeConfig` is set, so the
  // config swap dropping that extension is what makes the per-worktree file inert.
  // Preserving the extension "to be faithful to the repository" would put
  // log.showSignature + gpg.program back in play for every hardened call, and nothing
  // else in the runner would notice.
  const { repo, marker, base, gpg } = hostileRepo(t)
  git(repo, "config", "extensions.worktreeConfig", "true")
  git(repo, "config", "--worktree", "log.showSignature", "true")
  git(repo, "config", "--worktree", "gpg.program", gpg)

  return (async () => {
    // Control: the same repository, with the extension live, does run the program when
    // the config is not swapped — so this is not a test that cannot fail.
    const raw = await run("git", ["-C", repo, "log", "--oneline", `${base}..agent`], {
      env: SANITIZED_GIT_ENV,
      allowFailure: true,
    })
    assert.equal(raw.code, 0)
    assert.ok(fs.existsSync(marker), "control: the per-worktree config is live without the swap")
    fs.rmSync(marker, { force: true })

    const hardened = await sandboxGit(repo, ["log", "--oneline", `${base}..agent`], { allowFailure: true })
    assert.equal(hardened.code, 0)
    assert.equal(fs.existsSync(marker), false, "the per-worktree config must not be read")
  })()
})

/**
 * Line numbers of raw `run("git", ["-C", <…>.work, …])` calls without a marker.
 *
 * The behavioural tests above prove the hardened runner is safe; this proves it is
 * *used*. It exists because `/diff` called `run("git", ["-C", paths.work, ...])`
 * directly — the exact call the rule in AGENTS.md forbids — and that took a live
 * exploit to notice (see the gpg test above). A raw call is easy to add and invisible
 * in review, so the shape is checked mechanically.
 *
 * `git clone` into the work tree has no `-C` and is a different thing: the destination
 * is created, and no existing repository config is read. A call that must be raw
 * carries `raw-git-ok: <reason>` on its line or the line above it.
 */
export function rawWorkTreeGitCalls(source: string): number[] {
  const lines = source.split("\n")
  const found: number[] = []
  const call = /(?:^|[^\w.])(run|runRaw)\(\s*"git"/g
  let match: RegExpExecArray | null
  while ((match = call.exec(source)) !== null) {
    const chunk = source.slice(match.index, match.index + 400)
    if (!/-C",?\s*[\w.$\[\]"\']*\.work\b/.test(chunk)) continue
    const line = source.slice(0, match.index).split("\n").length
    const marked = (lines[line - 2] ?? "").includes("raw-git-ok") || (lines[line - 1] ?? "").includes("raw-git-ok")
    if (!marked) found.push(line)
  }
  return found
}

test("the scanner finds a raw call, and honours both the marker and sandboxGit", () => {
  // The control for the guard below: a check that cannot fail is not a check.
  const violation = [
    'const commits = await run(',
    '  "git",',
    '  ["-C", options.paths.work, "log", "--oneline", range],',
    '  { env: SANITIZED_GIT_ENV },',
    ')',
  ].join("\n")
  // The call's own line, which is where the marker goes when one is needed.
  assert.deepEqual(rawWorkTreeGitCalls(violation), [1])

  assert.deepEqual(rawWorkTreeGitCalls('await run("git", ["-C", p.work, "init"], { env })'), [1], "still found")
  assert.deepEqual(
    rawWorkTreeGitCalls('// raw-git-ok: .git does not exist yet\nawait run("git", ["-C", p.work, "init"], { env })'),
    [],
    "a marked call is allowed",
  )
  assert.deepEqual(rawWorkTreeGitCalls('await sandboxGit(paths.work, ["status"])'), [], "sandboxGit is the point")
  assert.deepEqual(
    rawWorkTreeGitCalls('await run("git", ["-C", p.projectDir, "status"], { env: SANITIZED_GIT_ENV })'),
    [],
    "the host project repository is not agent-controlled",
  )
  assert.deepEqual(
    rawWorkTreeGitCalls('await run("git", ["clone", "--no-hardlinks", p.projectDir, p.work], { env })'),
    [],
    "a clone into the work tree reads no existing config",
  )
})

test("no raw git call against the sandbox work tree outside lib/git.ts", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
  const offenders: string[] = []
  for (const dir of ["cmd", "lib", "sandbox", "sync", "secrets", "bundle"]) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (!name.endsWith(".ts")) continue
      const file = path.join(root, dir, name)
      if (file.endsWith(path.join("lib", "git.ts"))) continue
      const source = fs.readFileSync(file, "utf8")
      for (const line of rawWorkTreeGitCalls(source)) offenders.push(`${dir}/${name}:${line}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these call host git against the agent-controlled repository; use sandboxGit from lib/git.ts, ` +
      `or mark a deliberate exception with raw-git-ok:\n${offenders.join("\n")}`,
  )
})
