import assert from "node:assert/strict"
import { test } from "node:test"

import {
  CLAUDE_BINARY,
  CLAUDE_PLATFORM_PACKAGE,
  CLAUDE_TARBALL_PATH,
  CLAUDE_TARBALL_SHA256,
  CLAUDE_VERSION,
  CODEX_TARBALL_SHA256,
} from "../../lib/pins.ts"
import { ensureClaudeBinary } from "../../sandbox/rootfs.ts"

/**
 * The runtime artefacts, pinned.
 *
 * moat ships more than one agent runtime now, and the second one is fetched the same way as the
 * first: an npm *platform* package carrying a musl binary, verified against a digest before it is
 * unpacked. The properties below are the ones that make that safe rather than the values
 * themselves — a wrong digest is caught by the download, but a *missing* one, a tarball path that
 * is not where the executable actually lives, or a binary that lands outside the image are caught
 * here.
 */

test("a runtime triple with no pinned digest is refused, not downloaded", async () => {
  // arm64-musl has a platform package but no digest yet. It must fail closed: an unpinned binary
  // that becomes the agent runtime is the one artefact moat cannot be casual about.
  await assert.rejects(() => ensureClaudeBinary("linux-arm64-musl"), /no pinned digest/)
})

test("a triple the runtime is not pinned for at all is refused", async () => {
  await assert.rejects(() => ensureClaudeBinary("darwin-x64"), /not pinned for the/)
})

test("the claude artefact is pinned where the executable actually is", () => {
  // The layout is the difference that makes this a separate fetcher rather than a parameter of
  // Codex's: Claude's tarball puts its executable at the root, not under `vendor/<triple>/bin/`.
  // A path copied from the Codex code would extract nothing and leave an empty binary behind.
  assert.equal(CLAUDE_TARBALL_PATH, "package/claude")
  assert.equal(CLAUDE_BINARY, "/usr/local/bin/claude")
  assert.match(CLAUDE_PLATFORM_PACKAGE["linux-x64-musl"]!, /^@anthropic-ai\/claude-code-linux-x64-musl$/)
  assert.match(CLAUDE_VERSION, /^\d+\.\d+\.\d+$/)
  assert.equal(CLAUDE_TARBALL_SHA256["linux-x64-musl"]?.length, 64, "a digest is pinned, not a placeholder")
  assert.match(CLAUDE_TARBALL_SHA256["linux-x64-musl"]!, /^[0-9a-f]{64}$/)
  // The first runtime keeps its own pin: the second must not have replaced it.
  assert.match(CODEX_TARBALL_SHA256["linux-x64-musl"]!, /^[0-9a-f]{64}$/)
})
