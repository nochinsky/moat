import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { startProxyNetns } from "../../sandbox/proxy-netns.ts"
import { processStartTime } from "../../sandbox/launcher.ts"

test("a holder pid published before unshare is not a ready proxy namespace", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-proxy-ready-"))
  const bin = path.join(root, "bin")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "ip"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  fs.writeFileSync(path.join(bin, "nsenter"), '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nif [ "$1" = sh ]; then exec "$@"; fi\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(path.join(bin, "unshare"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 })
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}:${previousPath}`
  let pid = 0
  let start: string | null = null
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (pid && start && processStartTime(pid) === start) {
      try { process.kill(pid, "SIGKILL") } catch { /* already reaped */ }
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const original = fs.readlinkSync
  let reads = 0
  t.mock.method(fs, "readlinkSync", (file: fs.PathLike, ...args: unknown[]) => {
    if (String(file) === `/proc/${process.pid}/ns/net`) return "net:[box]"
    const match = /^\/proc\/(\d+)\/ns\/net$/.exec(String(file))
    if (!match) return Reflect.apply(original, fs, [file, ...args])
    pid = Number(match[1])
    start ??= processStartTime(pid)
    // The shell has written its pid, but has not completed `exec unshare` yet.
    return ++reads === 1 ? "net:[box]" : "net:[proxy]"
  })
  const handle = await startProxyNetns(process.pid, { dir: root, logFile: path.join(root, "proxy.log"), timeoutMs: 1000 })
  assert.equal(handle.holderPid, pid)
  assert.equal(reads, 2, "readiness must wait for a distinct namespace, not merely a visible pid")
  assert.match(fs.readFileSync(path.join(root, "proxy.log"), "utf8"), /net:\[proxy\]/)
})
