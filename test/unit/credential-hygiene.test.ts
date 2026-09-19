import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  scanRootfsForCredential,
  credentialRiskNotice,
  ttlToSeconds,
  type MintedCredential,
} from "../../secrets/broker.ts"
import { saveCredential } from "../../secrets/onboard.ts"
import { parseAllowlist } from "../../sandbox/egress.ts"
import { credentialExpired } from "../../sandbox/state.ts"

test("a TTL a Date cannot represent is refused instead of minted", () => {
  assert.equal(ttlToSeconds("8h"), 28800)
  assert.equal(ttlToSeconds("90s"), 90)
  assert.throws(() => ttlToSeconds("soon"), /invalid duration/)
  // Past the Date range, toISOString() throws RangeError and JSON.stringify
  // writes expiresAt as null: a crash, or a credential that never expires.
  assert.throws(() => ttlToSeconds("99999999999d"), /longer than 30 days/)
  assert.equal(ttlToSeconds("30d"), 2592000)
})

test("a lowercased allowlist entry is still the same host", () => {
  assert.deepEqual(parseAllowlist("API.DeepSeek.com, api.deepseek.com"), ["api.deepseek.com"])
})

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

test("the credential notice describes the network the box actually has", () => {
  const minted = {
    provider: "deepseek",
    fingerprint: "sha256:abc",
    ttlSeconds: 60,
    targetEnvVars: ["DEEPSEEK_API_KEY"],
    source: "env:DEEPSEEK_API_KEY",
  } as unknown as MintedCredential
  // A filtered box does not have an open network; saying so would train the
  // reader to ignore the notice.
  const filtered = credentialRiskNotice(minted, "filtered")
  assert.match(filtered, /allowlist/)
  assert.doesNotMatch(filtered, /network open/)
  assert.match(credentialRiskNotice(minted, "open"), /network open/)
  assert.match(credentialRiskNotice(minted, "isolated"), /not filtered/)
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
