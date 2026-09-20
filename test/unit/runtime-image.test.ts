import assert from "node:assert/strict"
import { test } from "node:test"

import { PROVISION_PACKAGES, RUNTIME_BINARY, RUNTIMES } from "../../lib/pins.ts"
import { imageCachePath } from "../../sandbox/rootfs.ts"

test("the image cache is keyed by runtime, so an image cannot silently lack one", () => {
  // Measured failure mode: a cached image built before a runtime existed is extracted for
  // an environment that asked for it, and the box dies with "command not found" at the
  // first task. The runtime set is part of the key instead.
  const codexOnly = imageCachePath(PROVISION_PACKAGES, ["codex"])
  const opencodeOnly = imageCachePath(PROVISION_PACKAGES, ["opencode"])
  const both = imageCachePath(PROVISION_PACKAGES, ["opencode", "codex"])
  assert.notEqual(codexOnly, opencodeOnly)
  assert.notEqual(codexOnly, both)
  assert.notEqual(opencodeOnly, both)
  // Order must not matter, or two callers with the same set get two images.
  assert.equal(imageCachePath(PROVISION_PACKAGES, ["codex", "opencode"]), both)
})

test("every runtime has a binary path inside the rootfs", () => {
  for (const runtime of RUNTIMES) {
    assert.match(RUNTIME_BINARY[runtime], /^\/usr\/local\/bin\/[a-z]+$/)
  }
  assert.equal(RUNTIME_BINARY.codex, "/usr/local/bin/codex")
  assert.equal(RUNTIME_BINARY.opencode, "/usr/local/bin/opencode")
})
