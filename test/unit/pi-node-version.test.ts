import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { EnvPaths } from "../../lib/paths.ts"
import { nodeSupportsPi } from "../../sandbox/pi-install.ts"

test("an installed but old Node is repaired; package presence alone cannot satisfy Pi", () => {
  const rootfs = fs.mkdtempSync(path.join(os.tmpdir(), "moat-pi-node-"))
  const paths = { rootfs } as EnvPaths
  try {
    fs.mkdirSync(path.join(rootfs, "usr/bin"), { recursive: true })
    fs.mkdirSync(path.join(rootfs, "lib/apk/db"), { recursive: true })
    fs.writeFileSync(path.join(rootfs, "usr/bin/node"), "not executable; must never run on the host")
    for (const [version, supported] of [["20.20.0", false], ["22.13.1", false], ["22.18.0", false], ["22.19.0", true], ["22.23.2", true], ["24.1.0", true]] as const) {
      fs.writeFileSync(path.join(rootfs, "lib/apk/db/installed"), `P:nodejs\nV:${version}-r0\n\nP:npm\nV:10.9.1-r0\n`)
      assert.equal(nodeSupportsPi(paths), supported, version)
    }
    fs.rmSync(path.join(rootfs, "usr/bin/node")); assert.equal(nodeSupportsPi(paths), false)
  } finally { fs.rmSync(rootfs, { recursive: true, force: true }) }
})
