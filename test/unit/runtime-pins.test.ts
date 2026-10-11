import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import { test } from "node:test"
import { PI_LOCK_SHA256, PI_VERSION, RUNTIME_BINARY } from "../../lib/pins.ts"
import { ensurePiArchive, piDependencyGraph } from "../../sandbox/pi-install.ts"

const lock = fs.readFileSync(new URL("../../bundle/pi-runtime/package-lock.json", import.meta.url), "utf8")
test("Pi and every shipped dependency are pinned, including platform packages", () => {
  assert.equal(crypto.createHash("sha256").update(lock).digest("hex"), PI_LOCK_SHA256)
  assert.equal(JSON.parse(lock).packages["node_modules/@earendil-works/pi-coding-agent"].version, PI_VERSION)
  const graph = piDependencyGraph(lock)
  assert.ok(graph.length > 20)
  assert.ok(graph.some(([name]) => name === "node_modules/@esbuild/linux-x64"))
  assert.ok(!graph.some(([name]) => name.includes("darwin") || name.includes("win32") || name.includes("linux-arm64")))
  assert.equal(RUNTIME_BINARY, "/usr/local/bin/pi")
  for (const [, pkg] of graph) assert.match(pkg.integrity!, /^sha512-/)
})
test("a changed lock is refused even if its URLs/integrities look plausible", () => {
  assert.throws(() => piDependencyGraph(lock + "\n"), /does not match/)
})
test("unsupported sandbox targets are refused before downloads", async () => {
  await assert.rejects(() => ensurePiArchive("darwin-x64"), /not pinned/)
  await assert.rejects(() => ensurePiArchive("linux-arm64-musl"), /not pinned/)
})
