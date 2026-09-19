import assert from "node:assert/strict"
import { test } from "node:test"

import { serveEntryScript } from "../../sandbox/serve.ts"

test("the credential deadline comes from the credential, not from the boot", () => {
  // The watchdog used to sleep the TTL counted from the script's start, so the box
  // outlived its key by however long the boot took (measured in the extras suite's
  // 6s-TTL case: the box stopped ~2s after expiry). The host passes the credential's
  // expiry as an epoch now.
  const script = serveEntryScript({ port: 4096, credentialTtlSeconds: 60 })
  assert.match(script, /MOAT_CREDENTIAL_EXPIRES_EPOCH/)
  assert.match(script, /REMAIN=\$\(\(EXPIRES_EPOCH - \$\(date \+%s\)\)\)/)
  // The check has to run BEFORE the agent is spawned: an already-dead credential
  // must not get an agent whose every model call can only fail.
  assert.ok(
    script.indexOf("not starting it") < script.indexOf("env OPENCODE_CONFIG="),
    "the expiry check must precede the spawn",
  )
  // And the TTL stays as the fallback for an environment without the epoch.
  assert.match(script, /else sleep 60; fi/)
})

test("no credential means no watchdog", () => {
  const script = serveEntryScript({ port: 4096, credentialTtlSeconds: null })
  assert.doesNotMatch(script, /REMAIN=/)
  assert.doesNotMatch(script, /stopping agent/)
  assert.match(script, /env OPENCODE_CONFIG=/)
})
