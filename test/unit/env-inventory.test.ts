import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { envPathsForId, envsDir } from "../../lib/paths.ts"
import { PROJECT_GONE, listEnvs } from "../../sandbox/state.ts"
import { destroyEnv } from "../../sandbox/rootfs.ts"

/** A throwaway MOAT_HOME. listEnvs() reads the variable at call time. */
function withHome(t: { after: (fn: () => void) => void }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moat-envs-"))
  const previous = process.env.MOAT_HOME
  process.env.MOAT_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.MOAT_HOME
    else process.env.MOAT_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

function makeEnv(home: string, id: string, state: unknown, opts: { rootfs?: boolean } = {}): string {
  const dir = path.join(home, "envs", id)
  fs.mkdirSync(dir, { recursive: true })
  if (state !== undefined) {
    fs.writeFileSync(path.join(dir, "state.json"), typeof state === "string" ? state : JSON.stringify(state))
  }
  if (opts.rootfs) fs.mkdirSync(path.join(dir, "rootfs"), { recursive: true })
  return dir
}

test("an environment whose project directory is gone stays in the inventory", (t) => {
  // The bug, measured: listEnvs() rebuilt paths with envPaths(projectDir), which
  // resolves the real path of that directory and throws when it is gone. The
  // catch swallowed the environment, so `moat status --all` could not report it
  // and `moat destroy --all` could not reclaim it: 800 MiB leaked invisibly.
  const home = withHome(t)
  const id = "0123456789ab"
  const missing = path.join(home, "project-that-was-deleted")
  makeEnv(home, id, { version: 1, id, projectDir: missing, status: "stopped" }, { rootfs: true })

  const envs = listEnvs()
  assert.equal(envs.length, 1)
  assert.equal(envs[0].id, id)
  assert.equal(envs[0].projectDir, missing)
  assert.equal(envs[0].dir, path.join(envsDir(), id))
  assert.equal(envs[0].rootfs, path.join(envsDir(), id, "rootfs"))
})

test("an environment whose state cannot be read is listed, and can be destroyed", (t) => {
  const home = withHome(t)
  const id = "abcdef012345"
  const dir = makeEnv(home, id, "{ not json at all", { rootfs: true })
  const envs = listEnvs()
  assert.equal(envs.length, 1)
  assert.equal(envs[0].id, id)
  assert.equal(envs[0].projectDir, PROJECT_GONE)
  assert.equal(destroyEnv(envs[0]), true)
  assert.equal(fs.existsSync(dir), false)
})

test("a half-created environment directory is still reclaimable", (t) => {
  const home = withHome(t)
  const id = "111111111111"
  const dir = makeEnv(home, id, undefined)
  const envs = listEnvs()
  assert.equal(envs.length, 1)
  assert.equal(envs[0].id, id)
  assert.equal(destroyEnv(envs[0]), true)
  assert.equal(fs.existsSync(dir), false)
})

test("the inventory ignores anything that is not an environment directory", (t) => {
  const home = withHome(t)
  fs.mkdirSync(path.join(home, "envs", "not-an-env"), { recursive: true })
  fs.mkdirSync(path.join(home, "envs", "0123456789AB"), { recursive: true })
  fs.writeFileSync(path.join(home, "envs", "README"), "hello")
  assert.deepEqual(listEnvs(), [])
})

test("paths for a project that no longer exists are built without touching the filesystem", (t) => {
  const home = withHome(t)
  const missing = path.join(home, "gone")
  const p = envPathsForId("0123456789ab", missing)
  assert.equal(p.projectDir, missing)
  assert.equal(p.dir, path.join(envsDir(), "0123456789ab"))
  assert.equal(p.work, path.join(p.rootfs, "work"))
  assert.equal(p.state, path.join(p.dir, "state.json"))
  assert.equal(fs.existsSync(missing), false)
})

test("destroyEnv reports an environment that is already gone", (t) => {
  withHome(t)
  const p = envPathsForId("0123456789ab", "/nowhere")
  assert.equal(destroyEnv(p), false)
})
