import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

/**
 * `--wire-api chat` is refused, because the pinned runtime will not start with it.
 *
 * Codex removed the chat protocol in February 2026 and the pinned binary says so plainly:
 *
 *     Error loading config.toml: `wire_api = "chat"` is no longer supported.
 *     How to fix: set `wire_api = "responses"` in your provider config.
 *
 * moat accepted the value anyway and wrote it into the rendered config, so a provider configured
 * with it produced a box whose agent could not load its own config. Found by measuring rather than
 * by reading: the value was accepted, the boot succeeded, and only running the runtime inside the
 * box showed the failure.
 *
 * Run through the real CLI rather than by importing a helper, because the validation lives in the
 * command and the thing being checked is what a user sees when they type it.
 */
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

test("--wire-api chat is refused with the reason, not written into a config", (t) => {
  const home = tempHome(t)
  const result = runProvider(
    ["add", "chatty", "--base-url", "https://example.test/v1", "--wire-api", "chat"],
    home,
  )

  assert.notEqual(result.code, 0, "the CLI accepted a wire API the pinned runtime rejects")
  assert.match(result.out, /chat protocol in February 2026/, "the refusal does not say why")
  assert.match(result.out, /--wire-api responses/, "the refusal does not name the way out")

  // The control: it must not have been written either. A refusal that still saves the provider
  // would leave a box that boots and then dies, which is the failure this guards.
  const store = path.join(home, "providers.json")
  if (fs.existsSync(store)) {
    assert.ok(!/chatty/.test(fs.readFileSync(store, "utf8")), "the refused provider was stored anyway")
  }
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
