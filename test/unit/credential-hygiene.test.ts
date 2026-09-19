import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { scanRootfsForCredential, credentialRiskNotice, type MintedCredential } from "../../secrets/broker.ts"
import { saveCredential } from "../../secrets/onboard.ts"
import { credentialExpired } from "../../sandbox/state.ts"

test("TTL expiry is decided by the recorded timestamp", () => {
  const state = (expiresAt: string | null) => ({ credential: expiresAt ? { expiresAt } : null }) as never
  assert.equal(credentialExpired(state(new Date(Date.now() - 1000).toISOString())), true)
  assert.equal(credentialExpired(state(new Date(Date.now() + 60_000).toISOString())), false)
  assert.equal(credentialExpired(state(null)), false)
  assert.equal(credentialExpired({ credential: { expiresAt: "not a date" } } as never), false)
})

test("the literal-flag notice names argv and shell history", () => {
  const minted = {
    provider: "deepseek",
    fingerprint: "sha256:abc",
    ttlSeconds: 60,
    targetEnvVars: [],
    source: "--credential flag",
  } as unknown as MintedCredential
  assert.match(credentialRiskNotice(minted), /ps/)
  assert.match(credentialRiskNotice(minted), /shell history/)
  const fromEnv = { ...minted, source: "env:DEEPSEEK_API_KEY" } as MintedCredential
  assert.doesNotMatch(credentialRiskNotice(fromEnv), /shell history/)
})

test("the rootfs scan finds the value only when it is on disk", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-scan-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "var/log/moat"), { recursive: true })
  fs.mkdirSync(path.join(root, "usr/local/share/moat"), { recursive: true })
  const leak = path.join(root, "var/log/moat/session.json")
  fs.writeFileSync(leak, "token=TEST-SECRET-VALUE\n")
  fs.writeFileSync(path.join(root, "usr/local/share/moat/opencode.json"), "{}\n")
  assert.deepEqual(scanRootfsForCredential(root, "TEST-SECRET-VALUE"), [leak])
  assert.deepEqual(scanRootfsForCredential(root, "NOT-PRESENT"), [])
})

test("the credential store is 0600 inside a repaired 0700 directory", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "moat-home-"))
  const home = path.join(base, "state")
  fs.mkdirSync(home, { mode: 0o755 })
  const previous = process.env.MOAT_HOME
  process.env.MOAT_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.MOAT_HOME
    else process.env.MOAT_HOME = previous
    fs.rmSync(base, { recursive: true, force: true })
  })
  const file = saveCredential("sk-test-value", "deepseek")
  assert.equal(fs.statSync(file).mode & 0o077, 0, "credentials file must not be group/world accessible")
  assert.equal(fs.statSync(home).mode & 0o077, 0, "state directory must be repaired to 0700")
  assert.equal(
    (JSON.parse(fs.readFileSync(file, "utf8")) as { deepseek: { value: string } }).deepseek.value,
    "sk-test-value",
  )
  assert.deepEqual(
    fs.readdirSync(home).filter((name) => name.includes(".tmp-")),
    [],
    "an atomic save must leave no temp file behind",
  )
})
