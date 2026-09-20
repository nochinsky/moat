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
  // The second line compared the constant with a retyped copy of itself, so it could
  // only ever fail if someone edited both. The path matters because the image cache
  // key names it: a binary installed anywhere else would be missing from a cached
  // image. What is worth asserting is the relationship, not the spelling.
  assert.equal(RUNTIME_BINARY.startsWith("/usr/local/bin/"), true)
  assert.match(RUNTIME_BINARY, /^\/usr\/local\/bin\/[a-z][a-z0-9-]*$/)
  // The cache key names the binary and its version, so a cached image cannot
  // silently lack one (this is the property the path is load-bearing for).
  const key = imageCachePath(PROVISION_PACKAGES, [RUNTIME_BINARY])
  assert.equal(key, imageCachePath(PROVISION_PACKAGES, [RUNTIME_BINARY]))
  assert.notEqual(key, imageCachePath(PROVISION_PACKAGES, ["/usr/local/bin/other"]))
})
