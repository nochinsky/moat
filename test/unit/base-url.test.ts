import assert from "node:assert/strict"
import { test } from "node:test"

import { checkBaseUrl } from "../../lib/provider.ts"

test("a base URL has to be usable, not merely parseable", () => {
  // Measured before this check existed: `moat up --base-url localhost:11434/v1`
  // provisioned, copied in and booted a *filtered* sandbox whose allowlist held no
  // provider address (exit 0, ready in 13s), so every model call the agent made
  // would fail. `new URL` accepts it: the protocol is "localhost:" and the
  // hostname is empty.
  const schemeLess = checkBaseUrl("base-url", "localhost:11434/v1")
  assert.ok(schemeLess, "the scheme-less form is refused")
  assert.match(schemeLess, /--base-url must be an http:\/\/ or https:\/\/ URL: localhost:11434\/v1/)
  assert.match(schemeLess, /did you mean http:\/\/localhost:11434\/v1\?/)

  assert.match(checkBaseUrl("base-url", "file:///tmp/endpoint") ?? "", /must be an http/)
  assert.match(checkBaseUrl("base-url", "not a url") ?? "", /--base-url is not a URL: not a url/)
  assert.match(checkBaseUrl("base-url", "   ") ?? "", /--base-url needs a URL/)
  // --upstream gets the same rule: it is a provider address too. A bare host does
  // not even parse, and the hint is what turns that into a one-second fix.
  const bareHost = checkBaseUrl("upstream", "api.deepseek.com")
  assert.match(bareHost ?? "", /--upstream is not a URL: api\.deepseek\.com/)
  assert.match(bareHost ?? "", /did you mean http:\/\/api\.deepseek\.com\?/)

  for (const good of [
    "https://api.deepseek.com",
    "http://127.0.0.1:5599/v1",
    "http://localhost:11434/v1",
    "https://gateway.internal:8443/v1",
  ]) {
    assert.equal(checkBaseUrl("base-url", good), null, good)
  }
})

test("every accepted base URL has an http(s) scheme and a host the allowlist can use", () => {
  // The property the check exists for: `providerHost()` and `providerProbe()` both
  // read `.hostname`, so an accepted value with an empty host is a filtered boot
  // with no provider in its allowlist.
  for (const value of ["https://api.deepseek.com", "http://127.0.0.1:1/v1", "http://[::1]:8080/v1", "https://x.y:443"]) {
    if (checkBaseUrl("base-url", value) !== null) continue
    const url = new URL(value)
    assert.ok(url.hostname.length > 0, value)
    assert.ok(url.protocol === "http:" || url.protocol === "https:", value)
  }
  for (const bad of ["localhost:11434/v1", "file:///tmp/x", "ftp://host/v1"]) {
    assert.notEqual(checkBaseUrl("base-url", bad), null, bad)
  }
})
