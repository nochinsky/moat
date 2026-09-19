import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { download, verifyFile } from "../../sandbox/rootfs.ts"

const BODY = Buffer.from("moat-download-test-content\n")
const SHA256 = crypto.createHash("sha256").update(BODY).digest("hex")
const SRI = "sha512-" + crypto.createHash("sha512").update(BODY).digest("base64")

async function startServer(body: Buffer): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-length": String(body.length) })
    response.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  return {
    url: "http://127.0.0.1:" + address.port + "/artifact",
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moat-dl-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("verifyFile accepts the published digests and rejects anything else", (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, "artifact")
  fs.writeFileSync(file, BODY)
  return (async () => {
    assert.equal(await verifyFile(file, { sha256: SHA256 }), true)
    assert.equal(await verifyFile(file, { integrity: SRI }), true)
    assert.equal(await verifyFile(file, {}), true)
    assert.equal(await verifyFile(file, { sha256: "0".repeat(64) }), false)
    assert.equal(await verifyFile(file, { integrity: "sha512-AAAA" }), false)
    assert.equal(await verifyFile(file, { integrity: "md5-whatever" }), false)
  })()
})

test("a verified download lands, and a corrupted cache is re-downloaded", async (t) => {
  const dir = tempDir(t)
  const server = await startServer(BODY)
  t.after(() => void server.close())
  const dest = path.join(dir, "artifact.bin")
  await download(server.url, dest, { sha256: SHA256 })
  assert.deepEqual(fs.readFileSync(dest), BODY)
  fs.writeFileSync(dest, "corrupted")
  await download(server.url, dest, { sha256: SHA256 })
  assert.deepEqual(fs.readFileSync(dest), BODY)
})

test("a digest mismatch leaves neither the file nor a temp behind", async (t) => {
  const dir = tempDir(t)
  const server = await startServer(BODY)
  t.after(() => void server.close())
  const dest = path.join(dir, "artifact.bin")
  await assert.rejects(() => download(server.url, dest, { sha256: "0".repeat(64) }), /digest mismatch/)
  assert.equal(fs.existsSync(dest), false)
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".part-")), [])
})

test("two concurrent downloads of one artifact end with a complete file", async (t) => {
  const dir = tempDir(t)
  const server = await startServer(BODY)
  t.after(() => void server.close())
  const dest = path.join(dir, "artifact.bin")
  await Promise.all([download(server.url, dest, { sha256: SHA256 }), download(server.url, dest, { sha256: SHA256 })])
  assert.deepEqual(fs.readFileSync(dest), BODY)
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".part-")), [])
})
