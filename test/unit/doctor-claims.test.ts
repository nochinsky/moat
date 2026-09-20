import assert from "node:assert/strict"
import { test } from "node:test"

import { doctorInjectedVarNames } from "../../secrets/broker.ts"
import { credentialExposureDetail, ownEnvNote } from "../../sandbox/isolation.ts"

test("the doctor's probe mirrors the box's own credential state", () => {
  // Measured: with `--no-credential` the probe still injected DEEPSEEK_API_KEY,
  // MOAT_INJECTED_CREDENTIAL and the MOAT_CREDENTIAL_* records, so the doctor reported
  // "credential visible to the agent" for a box that deliberately had nothing stealable
  // in it — and for a custom endpoint it claimed DEEPSEEK_API_KEY, which that box never has.
  const keyless = doctorInjectedVarNames({ credential: false, native: true })
  assert.deepEqual(keyless.sort(), ["MOAT_MODEL", "MOAT_MODEL_ID", "MOAT_PROVIDER_BASE_URL"])
  assert.equal(keyless.some((name) => /CREDENTIAL|API_KEY/.test(name)), false)

  const custom = doctorInjectedVarNames({ credential: true, native: false })
  assert.ok(custom.includes("MOAT_INJECTED_CREDENTIAL"))
  assert.ok(custom.includes("MOAT_MODEL"))
  assert.equal(custom.includes("DEEPSEEK_API_KEY"), false, "a custom endpoint never gets that name")

  const native = doctorInjectedVarNames({ credential: true, native: true })
  assert.ok(native.includes("DEEPSEEK_API_KEY"))
  assert.ok(native.includes("MOAT_CREDENTIAL_FINGERPRINT"))
  assert.equal(new Set(native).size, native.length, "no duplicate names")
})

test("only the names that carry a credential are called the credential", () => {
  const withKey = ownEnvNote(["DEEPSEEK_API_KEY", "MOAT_MODEL", "MOAT_PROVIDER_BASE_URL"])
  assert.match(withKey, /of which DEEPSEEK_API_KEY is the credential/)

  const configOnly = ownEnvNote(["MOAT_MODEL", "MOAT_MODEL_ID", "MOAT_PROVIDER_BASE_URL", "MOAT_SANDBOX"])
  assert.doesNotMatch(configOnly, /is the credential/)
  assert.match(configOnly, /plus moat's own MOAT_MODEL, MOAT_MODEL_ID, MOAT_PROVIDER_BASE_URL, MOAT_SANDBOX/)
  assert.equal(ownEnvNote([]), "")
})

test("the exposure does not offer key rotation for a box that has no key", () => {
  const keyless = credentialExposureDetail(["MOAT_MODEL"], false)
  assert.match(keyless, /None of them is a provider credential/)
  assert.match(keyless, /MOAT_MODEL/)
  assert.doesNotMatch(keyless, /spend-capped/)

  const withKey = credentialExposureDetail(["MOAT_INJECTED_CREDENTIAL", "MOAT_MODEL"], true)
  assert.match(withKey, /spend-capped token/)
  assert.match(withKey, /MOAT_INJECTED_CREDENTIAL/)

  assert.equal(credentialExposureDetail([], false), "no secret-looking variable reaches tool execution")
  assert.equal(credentialExposureDetail([], true), "no secret-looking variable reaches tool execution")
})
