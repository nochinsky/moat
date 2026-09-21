import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { installCodexFiles } from "../../bundle/codex.ts"
import { renderModelCatalog } from "../../bundle/model-catalog.ts"
import { DEEPSEEK, checkProviderID, customEndpoint } from "../../lib/provider.ts"
import { providerCredentialCandidates, validateStoredProvider } from "../../lib/providers.ts"
import { resolveProvider } from "../../lib/resolve-provider.ts"
import { credentialEnvNames, scanRootfsForCredential, toSandboxEnv, doctorInjectedVarNames } from "../../secrets/broker.ts"
import type { Parsed } from "../../lib/flags.ts"

/**
 * Phase 1 made the provider configurable, which is exactly the kind of change where a
 * guarantee leaks: the credential story used to be tied to one provider (`DEEPSEEK_API_KEY`,
 * one rendered `env_key`, one rootfs sweep). These tests are the four promises the phase had to
 * preserve, each stated for a provider that is not DeepSeek as well as for one that is.
 *
 * The program's Phase 1 section names them:
 *   - no credential ever reaches the image, for any configured provider;
 *   - `installCodexFiles` still refuses a config or brief containing a literal key;
 *   - `--no-credential` still produces a box with nothing stealable in it;
 *   - the post-boot rootfs credential sweep still runs and still aborts the boot.
 */

const parsed = (flags: Record<string, string> = {}): Parsed => ({ _: [], flags })

function tempRoot(t: { after: (fn: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-p1-cred-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test("a configured provider's key goes into the box under that provider's variable", () => {
  // The credential is environment-only, and which *name* it answers to is configuration. A
  // provider that declared `ACME_API_KEY` must not have its key delivered as
  // `DEEPSEEK_API_KEY`: the box would hold a key under a name its own client does not read,
  // and the rendered `env_key` would point at a variable nothing sets.
  const acme = { id: "acme", label: "Acme", envVar: "ACME_API_KEY", baseUrl: "https://acme.example/v1" }
  assert.deepEqual(providerCredentialCandidates(acme), ["ACME_API_KEY", "MOAT_CREDENTIAL", "DEEPSEEK_API_KEY"])

  const env = toSandboxEnv({
    provider: "acme",
    value: "acme-secret-value",
    targetEnvVars: ["ACME_API_KEY", "MOAT_INJECTED_CREDENTIAL"],
    fingerprint: "sha256:x",
    mintedAt: new Date(0),
    expiresAt: new Date(60_000),
    ttlSeconds: 60,
    source: "test",
    baseUrl: "https://acme.example/v1",
    model: "acme/model",
    modelId: "model",
    scopes: [],
  })
  assert.equal(env.ACME_API_KEY, "acme-secret-value")
  assert.equal(env.MOAT_INJECTED_CREDENTIAL, "acme-secret-value")
  assert.equal(env.DEEPSEEK_API_KEY, undefined, "a non-DeepSeek provider's key is not delivered under DeepSeek's name")
  // And the provider configuration travels whether or not a credential does.
  assert.equal(env.MOAT_PROVIDER_BASE_URL, "https://acme.example/v1")
  assert.equal(env.MOAT_MODEL_ID, "model")
})

test("the credential lookup follows the provider, and still finds moat's own names", () => {
  // Before Phase 1 the only two names were `DEEPSEEK_API_KEY` and `MOAT_CREDENTIAL`, so a user
  // who configured a provider whose key lives elsewhere had to rename it or pass
  // `--credential-env` on every command — and the "no credential" message named DeepSeek's
  // variable, which is a message about a provider they were not using.
  const previousHome = process.env.MOAT_HOME
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-p1-env-"))
  process.env.MOAT_HOME = root
  try {
    fs.writeFileSync(
      path.join(root, "providers.json"),
      JSON.stringify({ acme: { id: "acme", label: "Acme", envVar: "ACME_API_KEY" } }),
    )
    assert.deepEqual(credentialEnvNames("acme"), ["ACME_API_KEY", "DEEPSEEK_API_KEY", "MOAT_CREDENTIAL"])
    // The default provider's names are unchanged, and an unknown provider falls back to them
    // rather than inventing a variable.
    assert.deepEqual(credentialEnvNames(DEEPSEEK.id), ["DEEPSEEK_API_KEY", "MOAT_CREDENTIAL"])
    assert.deepEqual(credentialEnvNames("never-configured"), ["DEEPSEEK_API_KEY", "MOAT_CREDENTIAL"])
    assert.deepEqual(credentialEnvNames(undefined), ["DEEPSEEK_API_KEY", "MOAT_CREDENTIAL"])
  } finally {
    if (previousHome === undefined) delete process.env.MOAT_HOME
    else process.env.MOAT_HOME = previousHome
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("installCodexFiles refuses a literal key in the config, the brief or the catalog", (t) => {
  // The tripwire has to cover the new config shape: the provider block is now rendered from
  // configuration, so the `env_key` line and the `base_url` are the places a user's mistake
  // could paste a key into. Every text that goes into the box is checked, and the catalog is a
  // text it writes now rather than a vendored file.
  const root = tempRoot(t)
  const catalog = renderModelCatalog({ model: "m" })
  const clean = { config: 'model = "m"\n', brief: "the brief\n", catalog }
  installCodexFiles(root, clean)

  const keys = [
    "sk-abcdefghijklmnopqrstuvwx", // OpenAI / Anthropic / DeepSeek
    "AIzaSyA1234567890abcdefghijklmnopq", // Google
    "AKIAIOSFODNN7EXAMPLE", // AWS
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789", // GitHub
    "hf_abcdefghijklmnopqrstuvwxyz", // Hugging Face
    "xoxb-1234567890-abcdefghijkl", // Slack
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ]
  for (const key of keys) {
    // In the config: as a base_url, which is where a user pasting an endpoint with a key in it
    // would land, and as the model id.
    assert.throws(
      () => installCodexFiles(root, { ...clean, config: `base_url = "https://x/${key}"\n` }),
      /literal API key/,
      "config with " + key.slice(0, 8),
    )
    assert.throws(
      () => installCodexFiles(root, { ...clean, brief: `here is the key: ${key}\n` }),
      /literal API key/,
      "brief with " + key.slice(0, 8),
    )
    assert.throws(
      () => installCodexFiles(root, { ...clean, catalog: `{"models":[{"slug":"${key}"}]}` }),
      /literal API key/,
      "catalog with " + key.slice(0, 8),
    )
  }
  // A clean write still works after all those refusals, so the guard is not simply stuck.
  installCodexFiles(root, clean)
  assert.equal(fs.readFileSync(path.join(root, "root/.codex/config.toml"), "utf8"), clean.config)
})

test("--no-credential leaves a box with nothing stealable, for any provider", () => {
  // SPEC §1.3's mode. The claim is about names, and the names changed in this phase: a box
  // booted with `--no-credential` against a configured provider must be probed for no
  // credential variable at all — not DeepSeek's, not the provider's, not moat's injected name.
  const acme = { id: "acme", label: "Acme", envVar: "ACME_API_KEY" }
  const keyless = doctorInjectedVarNames({ credential: false, native: false })
  for (const name of ["DEEPSEEK_API_KEY", "ACME_API_KEY", "MOAT_INJECTED_CREDENTIAL", "MOAT_CREDENTIAL"]) {
    assert.equal(keyless.includes(name), false, `${name} must not be expected in a keyless box`)
  }
  // The provider *configuration* is still there, because it is not a secret and the runtime
  // needs it: a box with no key and no endpoint cannot call anything at all.
  assert.ok(keyless.includes("MOAT_PROVIDER_BASE_URL"))

  // With a credential, the provider's own name is the one expected for a native boot.
  const withKey = doctorInjectedVarNames({ credential: true, native: false })
  assert.ok(withKey.includes("MOAT_INJECTED_CREDENTIAL"))
  assert.equal(withKey.includes(DEEPSEEK.envVar), false, "a custom endpoint never has DeepSeek's variable")
  const native = doctorInjectedVarNames({ credential: true, native: true })
  assert.ok(native.includes(DEEPSEEK.envVar))
  // The label is carried so the probe can say which provider it modelled.
  assert.equal(acme.envVar, "ACME_API_KEY")
})

test("the rootfs sweep finds a key for any provider, and only when it is really on disk", (t) => {
  // The sweep is provider-agnostic by construction — it searches for the *value* — and that is
  // the property worth pinning after a phase that made the value's variable name configurable.
  // A sweep keyed on the variable name would have passed this phase's gate while missing every
  // other provider.
  const root = tempRoot(t)
  const rootfs = path.join(root, "rootfs")
  fs.mkdirSync(path.join(rootfs, "root/.codex"), { recursive: true })
  fs.mkdirSync(path.join(rootfs, "var/log/moat"), { recursive: true })
  const value = "acme-secret-value-8f3a1c9d2e"
  assert.deepEqual(scanRootfsForCredential(rootfs, value), [], "nothing there yet")

  fs.writeFileSync(path.join(rootfs, "root/.codex/auth.json"), `{"key":"${value}"}`)
  const found = scanRootfsForCredential(rootfs, value)
  assert.equal(found.length, 1)
  assert.match(found[0]!, /auth\.json$/)

  // A different provider's key in the same box is not this credential, so the sweep does not
  // report it: the check is for the value this boot injected.
  assert.deepEqual(scanRootfsForCredential(rootfs, "some-other-key-value-1234"), [])
  // An empty value is not a search for everything.
  assert.deepEqual(scanRootfsForCredential(rootfs, ""), [])
})

test("a provider id becomes a TOML key, so it is checked rather than trusted", () => {
  // The id reaches `[model_providers.<id>]` and the `provider/model` string. It now comes from a
  // flag and from a user-written file, so anything that is not a bare key — a dot, a space, a
  // quote, a newline — either breaks the parse or appends a section nobody asked for.
  for (const bad of ["bad id", "bad.id", 'bad"id', "bad\nid", "[evil]", "", "bad/id"]) {
    assert.throws(() => checkProviderID(bad), /invalid provider id/, JSON.stringify(bad))
  }
  for (const good of ["acme", "deepseek", "my-provider_2", "A1"]) {
    assert.equal(checkProviderID(good), good)
  }
  // The store applies its own, stricter rule at the point a provider is written.
  assert.equal(validateStoredProvider("acme", { label: "Acme" })?.label, "Acme")
  for (const bad of ["Acme", "has space", "has.dot", "", "-leading"]) {
    assert.equal(validateStoredProvider(bad, { label: "x" }), null, bad)
  }
  // A bad env-var name or a non-http endpoint is refused rather than stored and used later.
  assert.equal(validateStoredProvider("acme", { envVar: "has space" }), null)
  assert.equal(validateStoredProvider("acme", { envVar: "1LEADING" }), null)
  assert.equal(validateStoredProvider("acme", { baseUrl: "ftp://x/v1" }), null)
  assert.equal(validateStoredProvider("acme", { baseUrl: "not a url" }), null)
})

test("a provider is named or defaulted, never inferred from the environment", () => {
  // Invariant 8's spirit survives the unlock: `--provider` names a thing the user wrote down.
  // There is no reading of `ANTHROPIC_API_KEY` in the environment that changes which provider a
  // bare `moat up` uses, and an unconfigured name is refused rather than guessed at.
  const previousHome = process.env.MOAT_HOME
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-p1-infer-"))
  process.env.MOAT_HOME = root
  try {
    const plain = resolveProvider(parsed())
    assert.equal(plain.id, DEEPSEEK.id, "no flags and no state is the default provider")
    assert.throws(() => resolveProvider(parsed({ provider: "anthropic" })), /unknown provider/)
    // --provider and --base-url are different things and are refused together, rather than one
    // silently winning.
    assert.throws(
      () => resolveProvider(parsed({ provider: "acme", "base-url": "http://x/v1" })),
      /--provider are different things/,
    )
  } finally {
    if (previousHome === undefined) delete process.env.MOAT_HOME
    else process.env.MOAT_HOME = previousHome
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("a custom endpoint's label names the host, and its id stays a valid TOML key", () => {
  // The id is the config key and the model-string prefix, so it cannot be the hostname: a host
  // carries dots and a port, neither of which is a bare TOML key. The host goes in the label,
  // where a human reads it.
  const spec = customEndpoint("http://127.0.0.1:5599/v1")
  assert.equal(spec.id, "moat")
  assert.match(spec.label, /127\.0\.0\.1:5599/, "the label says where the traffic goes")
  assert.doesNotThrow(() => checkProviderID(spec.id))
})

test("the doctor models the box's own credential variables, not DeepSeek's by convention", () => {
  // The probe is handed `REDACTED-BY-DOCTOR` under each name in this list, and it prints the
  // list as a statement about the box: "these are in the environment tool execution inherits".
  // A name that would not be in the box makes the doctor assert something false about it, which
  // is the defect class Phase 0 fixed for `--no-credential`. Before this the only credential
  // name the doctor could model was `DEEPSEEK_API_KEY`, so a box configured against any other
  // provider was reported as having that variable — which it never has — and the variable it
  // really has went unlisted.
  const acmeVars = ["ACME_API_KEY", "MOAT_INJECTED_CREDENTIAL"]
  const keyless = doctorInjectedVarNames({ credential: false, native: false, credentialVars: acmeVars })
  assert.equal(keyless.includes("ACME_API_KEY"), false, "a keyless box has no credential variable at all")
  assert.equal(keyless.includes("MOAT_INJECTED_CREDENTIAL"), false)

  const acme = doctorInjectedVarNames({ credential: true, native: false, credentialVars: acmeVars })
  assert.ok(acme.includes("ACME_API_KEY"), "the variable the box really has is modelled")
  assert.ok(acme.includes("MOAT_INJECTED_CREDENTIAL"))
  assert.equal(acme.includes("DEEPSEEK_API_KEY"), false, "and the one it does not have is not")

  // A native boot is unchanged, with or without the derived list.
  const native = doctorInjectedVarNames({ credential: true, native: true, credentialVars: ["DEEPSEEK_API_KEY", "MOAT_INJECTED_CREDENTIAL"] })
  assert.ok(native.includes("DEEPSEEK_API_KEY"))
  assert.deepEqual(
    native.sort(),
    doctorInjectedVarNames({ credential: true, native: true }).sort(),
    "a native box's modelled environment is the same as before this changed",
  )
  // The provider configuration is always modelled: the runtime needs it whether or not a
  // credential was injected, and it is not a secret.
  for (const names of [keyless, acme, native]) {
    assert.ok(names.includes("MOAT_PROVIDER_BASE_URL"))
    assert.ok(names.includes("MOAT_MODEL_ID"))
  }
})
