import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

/**
 * `moat provider add` fills in what it can and refuses to invent the rest.
 *
 * A name moat knows (`openrouter`, `openai`) gets its endpoint and key variable from the models.dev
 * catalog, so the user does not have to look them up. Everything else still needs `--base-url`,
 * because moat has no way to know which endpoint an arbitrary id means — invariant 8 says a
 * provider is configuration the user wrote down, never something inferred.
 *
 * These run against an isolated `MOAT_HOME` in a subprocess, because the validation lives in the
 * command and the thing under test is what a user sees when they type it. They deliberately do not
 * assert what the *catalog* contains: it is a network document that changes, and a test that
 * depended on it would be testing models.dev rather than moat. An earlier version of this file did
 * exactly that, and passed or failed with connectivity.
 */
const REPO = path.join(import.meta.dirname, "..", "..")
const CLI = path.join(REPO, "cmd", "main.ts")

function provider(args: string[], home: string): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, "provider", ...args], {
        encoding: "utf8",
        env: { ...process.env, MOAT_HOME: home, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

function tempHome(t: { after: (fn: () => void) => void }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moat-known-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

test("an unknown provider name without an endpoint is refused, not guessed at", (t) => {
  const home = tempHome(t)
  const result = provider(["add", "acme"], home)

  assert.notEqual(result.code, 0, "a provider was configured with no endpoint")
  assert.match(result.out, /will not guess its endpoint/, "the refusal does not state the principle")
  assert.match(result.out, /--base-url/, "the refusal does not name the way to supply one")
  assert.match(result.out, /openrouter/, "the refusal does not list the names moat does know")
})

test("a provider moat does not know is added with an explicit endpoint", (t) => {
  const home = tempHome(t)
  const result = provider(["add", "acme", "--base-url", "https://acme.test/v1", "--env-var", "ACME_KEY"], home)

  assert.equal(result.code, 0, `an explicit endpoint was refused: ${result.out}`)
  const stored = JSON.parse(fs.readFileSync(path.join(home, "providers.json"), "utf8")) as Record<
    string,
    { baseUrl?: string; envVar?: string }
  >
  assert.equal(stored.acme?.baseUrl, "https://acme.test/v1")
  assert.equal(stored.acme?.envVar, "ACME_KEY")
})

test("an explicit endpoint wins over anything the catalog would supply", (t) => {
  // Someone pointing a known provider at a mirror or a gateway must get their endpoint, not the
  // catalog's. `openrouter` is a stand-in for any known name here.
  const home = tempHome(t)
  const result = provider(["add", "openrouter", "--base-url", "https://mirror.test/v1"], home)

  assert.equal(result.code, 0, `an explicit endpoint was refused: ${result.out}`)
  const stored = JSON.parse(fs.readFileSync(path.join(home, "providers.json"), "utf8")) as Record<
    string,
    { baseUrl?: string }
  >
  assert.equal(stored.openrouter?.baseUrl, "https://mirror.test/v1", "the catalog overrode an explicit endpoint")
})

test("an empty base URL is refused", (t) => {
  const home = tempHome(t)
  const result = provider(["add", "acme", "--base-url", ""], home)
  assert.notEqual(result.code, 0, "an empty base URL was accepted")
})
