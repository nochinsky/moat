import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

/** Pi supports both compatible OpenAI protocols. Verify the user-facing CLI and stored intent. */
const REPO = path.join(import.meta.dirname, "..", "..")
const CLI = path.join(REPO, "cmd", "main.ts")

function runProvider(args: string[], home: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, "provider", ...args], {
      encoding: "utf8",
      env: { ...process.env, MOAT_HOME: home, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { code: 0, out }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

function tempHome(t: { after: (fn: () => void) => void }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moat-wire-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

test("--wire-api chat is stored explicitly, not silently normalized to responses", (t) => {
  const home = tempHome(t)
  const result = runProvider(
    ["add", "chatty", "--base-url", "https://example.test/v1", "--wire-api", "chat"],
    home,
  )

  assert.equal(result.code, 0, result.out)
  const store = JSON.parse(fs.readFileSync(path.join(home, "providers.json"), "utf8"))
  assert.equal(store.chatty.wireApi, "chat")
})

test("--wire-api responses is accepted, and an unknown value is refused", (t) => {
  const okHome = tempHome(t)
  const ok = runProvider(
    ["add", "fine", "--base-url", "https://example.test/v1", "--wire-api", "responses"],
    okHome,
  )
  assert.equal(ok.code, 0, `a valid wire API was refused: ${ok.out}`)

  const badHome = tempHome(t)
  const bad = runProvider(
    ["add", "wrong", "--base-url", "https://example.test/v1", "--wire-api", "grpc"],
    badHome,
  )
  assert.notEqual(bad.code, 0, "an unknown wire API was accepted")
  assert.match(bad.out, /wire-api/)
})
