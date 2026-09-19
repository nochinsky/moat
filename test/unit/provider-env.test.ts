import assert from "node:assert/strict"
import { test } from "node:test"

import { sandboxProviderEnv, toSandboxEnv, type MintedCredential } from "../../secrets/broker.ts"

const config = { baseUrl: "http://127.0.0.1:5599/v1", model: "moat/mock-model", modelId: "mock-model" }

test("the provider configuration is not part of the credential", () => {
  // Measured: with `--no-credential` the box received no base URL at all, because the
  // three variables below were only ever set inside toSandboxEnv(minted). opencode
  // resolved {env:MOAT_PROVIDER_BASE_URL} to "", every model call died inside the box
  // with `ERR_INVALID_URL: "/chat/completions" cannot be parsed as a URL`, and the host
  // printed nothing but "0 tool calls". A base URL is configuration, not a secret.
  assert.deepEqual(sandboxProviderEnv(config), {
    MOAT_PROVIDER_BASE_URL: "http://127.0.0.1:5599/v1",
    MOAT_MODEL_ID: "mock-model",
    MOAT_MODEL: "moat/mock-model",
  })
})

test("an injected credential still carries the configuration with it", () => {
  const minted: MintedCredential = {
    provider: "moat",
    value: "sk-test-value-0123456789",
    targetEnvVars: [],
    fingerprint: "sha256:deadbeef",
    mintedAt: new Date(0),
    expiresAt: new Date(3600_000),
    ttlSeconds: 3600,
    source: "test",
    baseUrl: config.baseUrl,
    model: config.model,
    modelId: config.modelId,
    scopes: [],
  }
  const env = toSandboxEnv(minted)
  assert.deepEqual(
    { baseUrl: env.MOAT_PROVIDER_BASE_URL, model: env.MOAT_MODEL, modelId: env.MOAT_MODEL_ID },
    config,
  )
  assert.equal(env.MOAT_INJECTED_CREDENTIAL, "sk-test-value-0123456789")
  // The credential-bearing variables are the ones that must stay absent without one:
  // the no-credential mode is defined by "nothing stealable in the box".
  const secretNames = Object.keys(env).filter((name) => name.includes("CREDENTIAL"))
  assert.deepEqual(secretNames.sort(), [
    "MOAT_CREDENTIAL_EXPIRES_AT",
    "MOAT_CREDENTIAL_EXPIRES_EPOCH",
    "MOAT_CREDENTIAL_FINGERPRINT",
    "MOAT_CREDENTIAL_TTL_SECONDS",
    "MOAT_INJECTED_CREDENTIAL",
  ])
})
