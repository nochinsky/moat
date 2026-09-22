import assert from "node:assert/strict"
import { test } from "node:test"

import { CLAUDE_BRIEF_PATH } from "../../bundle/claude.ts"
import { DEFAULT_RUNTIME, RUNTIME_IDS, keepaliveEntryScript, resolveRuntime } from "../../bundle/runtime.ts"
import { READY_MARKER } from "../../sandbox/launcher.ts"

/**
 * The runtime seam.
 *
 * The seam was extracted by the second implementation rather than designed ahead of it, which is
 * why it is four things wide. What these tests pin is that the two runtimes are actually different
 * where they must be — the body a turn runs — and identical where they should be, and that a flag
 * naming a runtime moat does not ship is refused instead of quietly falling back to Codex.
 */

test("the registry names both runtimes, and refuses anything else by name", () => {
  assert.deepEqual([...RUNTIME_IDS].sort(), ["claude", "codex"])
  assert.equal(DEFAULT_RUNTIME, "codex")
  assert.equal(resolveRuntime("codex").binary, "/usr/local/bin/codex")
  assert.equal(resolveRuntime("claude").binary, "/usr/local/bin/claude")
  // Silently booting Codex for `--runtime gemini` is the guess invariant 8 is about, one layer down.
  assert.throws(() => resolveRuntime("gemini"), /unknown runtime "gemini"/)
  assert.throws(() => resolveRuntime(""), /unknown runtime/)
})

test("the claude body feeds the prompt on stdin and renders the policy as arguments", () => {
  const body = resolveRuntime("claude").execBody("fix the failing tests")
  // `--allowedTools` is variadic and eats a trailing positional argument; the measured failure was
  // "Input must be provided either through stdin or as a prompt argument".
  assert.match(body, /printf '%s' 'fix the failing tests' \| claude -p --output-format stream-json/)
  assert.match(body, /--permission-mode acceptEdits/)
  assert.match(body, /--allowedTools Bash Edit Write Read Glob Grep NotebookEdit/)
  assert.match(body, new RegExp(`--append-system-prompt-file ${CLAUDE_BRIEF_PATH.replace(/\//g, "\\/")}`))
  assert.match(body, /^cd \/work$/m)
  // The whole point: the box never asks, and never has to skip permission checks to manage it —
  // Claude Code refuses `--dangerously-skip-permissions` as root, which moat's agent is.
  assert.doesNotMatch(body, /dangerously-skip-permissions/)
})

test("the codex body is unchanged by the seam", () => {
  const body = resolveRuntime("codex").execBody("fix the failing tests")
  assert.match(body, /exec codex exec --json --skip-git-repo-check 'fix the failing tests' <\/dev\/null/)
  assert.match(body, /^cd \/work$/m)
})

test("the keepalive is runtime-neutral, and checks the deadline before reporting ready", () => {
  const script = keepaliveEntryScript()
  assert.match(script, new RegExp(READY_MARKER.replace(/[[\]]/g, "\\$&")))
  assert.doesNotMatch(script, /codex/i, "the second runtime must not wait on a string naming the first")
  // The order is the point: a box whose credential was already dead printed ready and then exited,
  // so `moat up` waited, saw the marker, and recorded a running sandbox that was already gone.
  assert.ok(
    script.indexOf(READY_MARKER) > script.indexOf("MOAT_CREDENTIAL_EXPIRES_EPOCH"),
    "the expiry check must come before the readiness line",
  )
  assert.match(script, /exec sleep 2147483647/)
})
