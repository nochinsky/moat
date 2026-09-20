import assert from "node:assert/strict"
import { test } from "node:test"

import { PROVISION_PACKAGES, RUNTIME_BINARY } from "../../lib/pins.ts"
import { imageCachePath } from "../../sandbox/rootfs.ts"

test("the image cache key carries the binaries the image installs", () => {
  // Measured failure mode: a cached image built before a binary existed is extracted for an
  // environment that needs it, and the box dies with "command not found" at the first task.
  // The binary set is part of the key, and the pinned version is in it too.
  const one = imageCachePath(PROVISION_PACKAGES, [RUNTIME_BINARY])
  const two = imageCachePath(PROVISION_PACKAGES, [RUNTIME_BINARY, "/usr/local/bin/other"])
  assert.notEqual(one, two)
  // Order must not matter, or two callers with the same set get two images.
  assert.equal(imageCachePath(PROVISION_PACKAGES, [RUNTIME_BINARY, "/usr/local/bin/other"]), two)
  // The default is the runtime moat actually installs.
  assert.equal(imageCachePath(PROVISION_PACKAGES), one)
  // A different package set is a different image.
  assert.notEqual(imageCachePath([...PROVISION_PACKAGES, "vim"]), one)
})

test("the runtime binary lands under /usr/local/bin", () => {
  assert.match(RUNTIME_BINARY, /^\/usr\/local\/bin\/[a-z]+$/)
  assert.equal(RUNTIME_BINARY, "/usr/local/bin/codex")
})
