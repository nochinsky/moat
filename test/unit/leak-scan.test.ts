import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { envPaths } from "../../lib/paths.ts"
import { applyPlan, planApply } from "../../sync/apply.ts"
import { fetchBranch } from "../../sync/copyout.ts"
import {
  credentialLeakWarning,
  fetchedRevs,
  leakingFiles,
  injectedCredentialVarNames,
  knownCredentialValues,
  parseGrepPaths,
} from "../../sync/leak-scan.ts"

const KEY = "sk-moat-leak-scan-0123456789"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
}

/**
 * Put the credential where moat itself would find it, and take it away again.
 *
 * MOAT_HOME points at an empty directory so the developer's real credential store
 * is not part of the test: the value under test has to be the only one.
 */
function withCredential(t: { after: (fn: () => void) => void }, root: string, value: string | null): void {
  const previousHome = process.env.MOAT_HOME
  const previousKey = process.env.DEEPSEEK_API_KEY
  const previousCredential = process.env.MOAT_CREDENTIAL
  process.env.MOAT_HOME = path.join(root, "moat-home")
  delete process.env.MOAT_CREDENTIAL
  if (value === null) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = value
  t.after(() => {
    if (previousHome === undefined) delete process.env.MOAT_HOME
    else process.env.MOAT_HOME = previousHome
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousKey
    if (previousCredential === undefined) delete process.env.MOAT_CREDENTIAL
    else process.env.MOAT_CREDENTIAL = previousCredential
  })
}

test("the values to match come from the sources moat itself reads", () => {
  const values = knownCredentialValues(
    { DEEPSEEK_API_KEY: "sk-env-value-0123456", MOAT_CREDENTIAL: "short", OTHER_KEY: "not-moat" } as NodeJS.ProcessEnv,
    () => ({ deepseek: { value: "stored-value-0123456" }, tiny: { value: "x" } }),
  )
  assert.deepEqual(values.sort(), ["sk-env-value-0123456", "stored-value-0123456"])
  // An unreadable store must not break a fetch; it just contributes nothing.
  assert.deepEqual(
    knownCredentialValues({} as NodeJS.ProcessEnv, () => {
      throw new Error("EACCES")
    }),
    [],
  )
})

test("the file scan matches bytes and reports what it refused to read", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-leak-files-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, "a.txt"), `key = ${KEY}\n`)
  fs.writeFileSync(path.join(root, "b.txt"), "nothing to see\n")
  fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(4096) + KEY)
  // Binary files are searched too: the comparison is on bytes, not decoded text.
  fs.writeFileSync(path.join(root, "c.bin"), Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from(KEY)]))
  const entries = ["a.txt", "b.txt", "big.txt", "c.bin"].map((name) => ({
    path: name,
    file: path.join(root, name),
  }))
  const scanned = leakingFiles(entries, [KEY], 1024)
  assert.deepEqual(scanned.leaks, ["a.txt", "c.bin"])
  assert.deepEqual(scanned.skipped, ["big.txt"])
  // The control: with no values there is nothing to match, and nothing to report.
  assert.deepEqual(leakingFiles(entries, []), { leaks: [], skipped: [] })
})

test("grep output is attributed to paths, not to revisions", () => {
  assert.deepEqual(parseGrepPaths("a1b2:src/one.ts\nff00:src/one.ts\ncc11:src/../two.ts\n"), [
    "src/one.ts",
    "src/../two.ts",
  ])
  // -z framing: records are NUL-terminated, and a path with a space is verbatim.
  assert.deepEqual(parseGrepPaths("a1b2:src/one.ts\0cc11:a b.ts\0"), ["src/one.ts", "a b.ts"])
  assert.deepEqual(parseGrepPaths(""), [])
})

function hostAndSandbox(t: { after: (fn: () => void) => void }, key: string | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-leak-fetch-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  withCredential(t, root, key)
  const host = path.join(root, "project")
  fs.mkdirSync(host, { recursive: true })
  git(host, "init", "-q", "-b", "main")
  git(host, "config", "user.email", "a@b")
  git(host, "config", "user.name", "t")
  fs.writeFileSync(path.join(host, "readme.md"), "the project\n")
  git(host, "add", "-A")
  git(host, "commit", "-qm", "base")
  const p = envPaths(host)
  fs.mkdirSync(path.dirname(p.work), { recursive: true })
  execFileSync("git", ["clone", "-q", host, p.work])
  git(p.work, "config", "user.email", "a@b")
  git(p.work, "config", "user.name", "t")
  git(p.work, "checkout", "-q", "-b", "moat-session-test")
  return { root, host, p }
}

test("a fetch names the credential in the commits it brings in, even one deleted later", (t) => {
  const f = hostAndSandbox(t, KEY)
  return (async () => {
    // The shape that matters: the key is committed, then removed in a later commit.
    // The working tree is clean at the tip, and the blob is still in the objects the
    // fetch copies into the host repository.
    fs.writeFileSync(path.join(f.p.work, "leaked.env"), `DEEPSEEK_API_KEY=${KEY}\n`)
    git(f.p.work, "add", "-A")
    git(f.p.work, "commit", "-qm", "add config")
    fs.rmSync(path.join(f.p.work, "leaked.env"))
    git(f.p.work, "add", "-A")
    git(f.p.work, "commit", "-qm", "remove it again")

    const result = await fetchBranch(f.p, "moat-session-test")
    assert.deepEqual(result.credentialLeaks, ["leaked.env"])
  })()
})

test("a fetch says nothing when none of the content holds the credential", (t) => {
  const f = hostAndSandbox(t, KEY)
  return (async () => {
    fs.writeFileSync(path.join(f.p.work, "feature.ts"), "export const x = 1\n")
    git(f.p.work, "add", "-A")
    git(f.p.work, "commit", "-qm", "the ordinary case")
    const result = await fetchBranch(f.p, "moat-session-test")
    assert.deepEqual(result.credentialLeaks, [])
  })()
})

test("with no credential on the host there is nothing to match, and nothing claimed", (t) => {
  const f = hostAndSandbox(t, null)
  return (async () => {
    fs.writeFileSync(path.join(f.p.work, "leaked.env"), `DEEPSEEK_API_KEY=${KEY}\n`)
    git(f.p.work, "add", "-A")
    git(f.p.work, "commit", "-qm", "add config")
    const result = await fetchBranch(f.p, "moat-session-test")
    // Not "clean": not scanned. The distinction is the point of the field.
    assert.deepEqual(result.credentialLeaks, [])
  })()
})

test("the warning is not a place to print the agent's bytes", () => {
  // The file names in the warning are the agent's, and a terminal acts on escapes.
  const text = credentialLeakWarning(["src/a\u001b[2Jb.ts", "ok.ts"], "about to be written into your working tree")
  assert.equal(text.includes("\u001b"), false)
  assert.match(text, /src\/ab\.ts/)
  assert.match(text, /contain the credential moat injected/)
})

test("the commit search is bounded, and says when the bound was reached", (t) => {
  const f = hostAndSandbox(t, KEY)
  return (async () => {
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(f.p.work, `f${n}.txt`), `${n}\n`)
      git(f.p.work, "add", "-A")
      git(f.p.work, "commit", "-qm", `c${n}`)
    }
    // `before` is the shared base, which is what the fetch path passes: the host's own
    // HEAD. Without it the range would be the whole history, including the project's.
    const base = git(f.p.work, "rev-parse", "main").trim()
    const all = await fetchedRevs(f.p.work, "refs/heads/moat-session-test", base, 10)
    assert.deepEqual({ n: all.revs.length, truncated: all.truncated }, { n: 3, truncated: false })
    const capped = await fetchedRevs(f.p.work, "refs/heads/moat-session-test", base, 2)
    assert.deepEqual({ n: capped.revs.length, truncated: capped.truncated }, { n: 2, truncated: true })
  })()
})

function applyFixture(t: { after: (fn: () => void) => void }, key: string | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-leak-apply-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  withCredential(t, root, key)
  const host = path.join(root, "host")
  const dir = path.join(root, "env")
  const work = path.join(dir, "rootfs", "work")
  fs.mkdirSync(host, { recursive: true })
  fs.mkdirSync(path.dirname(work), { recursive: true })
  git(host, "init", "-q")
  git(host, "config", "user.email", "a@b")
  git(host, "config", "user.name", "t")
  fs.writeFileSync(path.join(host, "readme.md"), "base\n")
  git(host, "add", "-A")
  git(host, "commit", "-qm", "base")
  execFileSync("git", ["clone", "-q", host, work])
  git(work, "config", "user.email", "a@b")
  git(work, "config", "user.name", "t")
  git(work, "update-ref", "refs/moat/baseline", "HEAD")
  const p = { id: "t", projectDir: host, dir, rootfs: path.join(dir, "rootfs"), work, mountpoint: "", state: "", logs: "", snapshots: "", entryScript: "", auditDir: "" }
  return { root, host, work, p: p as never }
}

test("an apply names the credential in the file it is about to write, and still writes it", (t) => {
  const f = applyFixture(t, KEY)
  return (async () => {
    fs.writeFileSync(path.join(f.work, "config.ts"), `export const key = "${KEY}"\n`)
    fs.writeFileSync(path.join(f.work, "clean.ts"), "export const x = 1\n")
    const plan = await planApply(f.p)
    assert.deepEqual(plan.credentialLeaks, ["config.ts"])
    // A warning, not a gate: the user asked for the work and still gets it.
    const result = await applyPlan(f.p, plan)
    assert.equal(result.applied, 2)
    assert.match(fs.readFileSync(path.join(f.host, "config.ts"), "utf8"), /sk-moat-leak-scan/)
  })()
})

test("an apply whose content is clean reports nothing", (t) => {
  const f = applyFixture(t, KEY)
  return (async () => {
    fs.writeFileSync(path.join(f.work, "clean.ts"), "export const x = 1\n")
    const plan = await planApply(f.p)
    assert.deepEqual(plan.credentialLeaks, [])
  })()
})

test("a key passed as --credential-env is still scanned for on copy-out", () => {
  // `--credential-env TEAM_KEY` is a supported way to hand moat a key, and the scan
  // used to look only at the two names moat knows by convention. A key passed that
  // way was invisible: commit it into the project and `moat fetch` brought it to the
  // host with no warning at all, which is the one outcome this scan exists to
  // prevent. The names the boot actually injected under are recorded in state.json
  // and read back here.
  const env = { TEAM_KEY: "team-secret-0123456789" } as NodeJS.ProcessEnv
  assert.deepEqual(knownCredentialValues(env, () => ({}), { alsoNames: undefined }), [], "invisible without the names")
  assert.deepEqual(
    knownCredentialValues(env, () => ({}), { alsoNames: ["TEAM_KEY"] }),
    ["team-secret-0123456789"],
    "and visible when state.json names the variable the boot used",
  )
  // The conventional names still work, and neither source can duplicate the other.
  assert.deepEqual(
    knownCredentialValues(
      { DEEPSEEK_API_KEY: "conventional-0123456", TEAM_KEY: "team-secret-0123456789" } as NodeJS.ProcessEnv,
      () => ({}),
      { alsoNames: ["DEEPSEEK_API_KEY", "TEAM_KEY"] },
    ).sort(),
    ["conventional-0123456", "team-secret-0123456789"],
  )
})

test("the scan says loudly when it had nothing to compare against", () => {
  // The "did not run" notice was `log.debug`, and `--verbose` was a no-op, so the one
  // message that says the scan never happened was unreachable. Silence from a scan
  // that did not run and silence from a scan that found nothing look identical in a
  // terminal, and only one of them is good news.
  const source = fs.readFileSync(new URL("../../sync/leak-scan.ts", import.meta.url), "utf8")
  const body = source.slice(source.indexOf("export function noteScanSkipped"))
  assert.match(body.slice(0, 400), /log\.warn\(/, "the notice is a warning, not a debug line")
  assert.doesNotMatch(body.slice(0, 400), /log\.debug\(/, "and not hidden behind --verbose")
  assert.match(body.slice(0, 400), /NOT searched/)
})

test("the variable names come from the environment's own state, not from this process", () => {
  // The end of the path above: the boot writes the names it injected under into
  // state.json, and copy-out reads them from there. A state.json written by an older
  // moat has no such field, and that must mean "fall back to the conventional names",
  // not a crash.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-leaknames-"))
  try {
    const statePath = path.join(root, "state.json")
    const write = (credential: unknown): void =>
      fs.writeFileSync(statePath, JSON.stringify({ version: 1, id: "x", projectDir: root, credential }))
    write({ provider: "deepseek", fingerprint: "f", mintedAt: "", expiresAt: "", sourceEnvVars: ["TEAM_KEY", "MOAT_CREDENTIAL"] })
    assert.deepEqual(injectedCredentialVarNames({ state: statePath }), ["TEAM_KEY", "MOAT_CREDENTIAL"])
    // An older state has no field at all.
    write({ provider: "deepseek", fingerprint: "f", mintedAt: "", expiresAt: "" })
    assert.deepEqual(injectedCredentialVarNames({ state: statePath }), [])
    // A hand-edited file with the wrong shape contributes nothing rather than throwing.
    write({ provider: "deepseek", sourceEnvVars: ["TEAM_KEY", 7, null] })
    assert.deepEqual(injectedCredentialVarNames({ state: statePath }), ["TEAM_KEY"])
    // No state at all (an environment mid-destroy) is the same answer.
    fs.rmSync(statePath)
    assert.deepEqual(injectedCredentialVarNames({ state: statePath }), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
