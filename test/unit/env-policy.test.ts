import assert from "node:assert/strict"
import { test } from "node:test"

import { extraSandboxEnv, sandboxEnv } from "../../sandbox/launcher.ts"

test("MOAT_SANDBOX_ENV only carries MOAT_ names and never a managed one", () => {
  // The prefix whitelist is what keeps this an escape hatch rather than a way to hand the
  // sandbox the host's environment: HOME and a key are dropped, and so is a name another
  // runtime used to read.
  const env = extraSandboxEnv("MOAT_MODEL=x,HOME=/etc,DEEPSEEK_API_KEY=leak,OPENCODE_CLIENT=moat", ["MOAT_MODEL"])
  assert.deepEqual(env, {})
  assert.deepEqual(extraSandboxEnv("MOAT_EXTRA=1", []), { MOAT_EXTRA: "1" })
  assert.deepEqual(extraSandboxEnv("", []), {})
  // A managed name is dropped even though it has the right prefix.
  assert.deepEqual(extraSandboxEnv("MOAT_INJECTED_CREDENTIAL=evil", ["MOAT_INJECTED_CREDENTIAL"]), {})
})

test("the sandbox environment is a pure whitelist", () => {
  const env = sandboxEnv({ MOAT_EXTRA: "1" })
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "LC_ALL", "MOAT_EXTRA", "MOAT_SANDBOX", "PATH", "TERM"])
  assert.equal(env.HOME, "/root")
})
