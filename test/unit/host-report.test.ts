import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"

import { probeHost } from "../../lib/host.ts"

function hostFixture(t: TestContext, kvm: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-host-report-"))
  const previousPath = process.env.PATH
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  fs.writeFileSync(path.join(root, "unshare"), '#!/bin/sh\ncase "$*" in *mknod*) echo MKNOD_FAIL;; *) printf "USERNS_OK\\nPIDNS_OK\\n";; esac\n', { mode: 0o755 })
  process.env.PATH = `${root}:${previousPath}`
  Object.defineProperty(process, "platform", { value: "linux", configurable: true })
  const read = fs.readFileSync
  const exists = fs.existsSync
  const access = fs.accessSync
  t.mock.method(fs, "readFileSync", ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (file === "/proc/sys/kernel/osrelease") return "6.6.0-microsoft-standard-WSL2"
    return Reflect.apply(read, fs, [file, ...args])
  }) as typeof read)
  t.mock.method(fs, "existsSync", (file: fs.PathLike) => file === "/dev/kvm" ? kvm : exists(file))
  t.mock.method(fs, "accessSync", (file: fs.PathLike, mode?: number) => {
    if (file !== "/dev/kvm") access(file, mode)
  })
  t.after(() => {
    Object.defineProperty(process, "platform", platform)
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    fs.rmSync(root, { recursive: true, force: true })
  })
}

test("WSL2 with namespaces is a default-backend host, not a container-only host", async t => {
  hostFixture(t, false)
  const report = await probeHost()
  assert.equal(report.wsl, true)
  assert.equal(report.userns, true)
  assert.deepEqual(report.problems, [])
  assert.equal(report.kvm, false)
  assert.match(report.notes.join("\n"), /KVM is not required.*namespace backend/)
  assert.doesNotMatch(report.notes.join("\n"), /container path is the supported mode/)
})

test("accessible KVM is a measured device, not a shipped microVM backend", async t => {
  hostFixture(t, true)
  const report = await probeHost()
  assert.equal(report.kvm, true)
  assert.match(report.notes.join("\n"), /no production microVM backend/)
  assert.doesNotMatch(report.notes.join("\n"), /microVM path is available/)
})

test("unsupported platforms name Linux and WSL2 without prescribing containers", async t => {
  hostFixture(t, false)
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
  const report = await probeHost()
  assert.equal(report.linux, false)
  assert.match(report.problems.join("\n"), /Linux x86-64, including WSL2/)
  assert.doesNotMatch(report.problems.join("\n"), /via the container path/)
})
