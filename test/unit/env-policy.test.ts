import assert from "node:assert/strict"
import { test } from "node:test"

import { extraSandboxEnv, sandboxEnv } from "../../sandbox/launcher.ts"

test("MOAT_SANDBOX_ENV only carries OPENCODE_/MOAT_ names and never a managed one", () => {
  const env = extraSandboxEnv("OPENCODE_CLIENT=moat,MOAT_MODEL=x,HOME=/etc,DEEPSEEK_API_KEY=leak", ["MOAT_MODEL"])
  assert.deepEqual(env, { OPENCODE_CLIENT: "moat" })
  assert.deepEqual(extraSandboxEnv("", []), {})
  // A managed name is dropped even though it has the right prefix.
  assert.deepEqual(extraSandboxEnv("MOAT_INJECTED_CREDENTIAL=evil", ["MOAT_INJECTED_CREDENTIAL"]), {})
})

test("the sandbox environment is a pure whitelist", () => {
  const env = sandboxEnv({ MOAT_PORT: "1" })
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "LC_ALL", "MOAT_PORT", "MOAT_SANDBOX", "PATH", "TERM"])
  assert.equal(env.HOME, "/root")
})
