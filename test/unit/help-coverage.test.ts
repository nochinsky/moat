import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

/**
 * Every command moat has is in its own `--help`.
 *
 * `moat provider` was missing from the help long after it became the way to point moat at another
 * endpoint, which made the command that answers "can I use my own provider?" undiscoverable from
 * the one place a user looks. Nothing caught it because the help is a hand-written string and
 * nothing compared it to the command table.
 *
 * This compares them. The table in `lib/flags.ts` is the definition of what exists — the dispatcher
 * and the flag parser both read it — so a command there and absent here is a bug in the help
 * rather than a matter of taste.
 */
const REPO = path.join(import.meta.dirname, "..", "..")
const CLI = path.join(REPO, "cmd", "main.ts")

/**
 * Commands deliberately not given their own help line.
 *
 * `help` and `version` are aliases of `--help` and `--version`, which the help does list.
 */
const ALIASES = new Set(["help", "version"])

function commands(): string[] {
  // Read the table the dispatcher reads, so this cannot drift from the real command set. The
  // scan stops at the closing brace of `COMMAND_FLAGS`: running past it picked up the entries of
  // `SPEC`, which are flag names, and reported `json`, `verbose` and `model` as undocumented
  // commands. That is how the first version of this file failed.
  const flags = fs.readFileSync(path.join(REPO, "lib", "flags.ts"), "utf8")
  const start = flags.indexOf("export const COMMAND_FLAGS")
  const end = flags.indexOf("\n}\n", start)
  assert.ok(start > 0 && end > start, "could not find the COMMAND_FLAGS table")
  return [...flags.slice(start, end).matchAll(/^ {2}([a-z][a-z-]*):/gm)].map((m) => m[1]!)
}

function help(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moat-help-"))
  try {
    return execFileSync(process.execPath, [CLI, "--help"], {
      encoding: "utf8",
      env: { ...process.env, MOAT_HOME: home, NO_COLOR: "1" },
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

test("every command in the flag table appears in --help", () => {
  const all = commands()
  assert.ok(all.length > 10, `the command table parsed as ${all.length} entries; the scan is broken`)

  const text = help()
  const missing = all.filter((name) => !new RegExp(`^\\s+moat ${name}\\b`, "m").test(text))
  assert.deepEqual(
    missing.filter((name) => !ALIASES.has(name)),
    [],
    "a command exists but is not in --help, so nobody can find it",
  )
})

test("the control: a command that does not exist is not in --help", () => {
  // Without this, a regex that matched anything would pass the test above. `provider` was the
  // real case; this proves the matcher can tell present from absent.
  assert.doesNotMatch(help(), /^\s+moat daemon\b/m)
})
