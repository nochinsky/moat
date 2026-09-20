import assert from "node:assert/strict"
import { test } from "node:test"

import { interactiveTerm, sandboxEnv } from "../../sandbox/launcher.ts"

test("an interactive boot advertises the host terminal type, sanitised", () => {
  // Measured: TERM=dumb made Codex's TUI stop at "Continue anyway? [y/N]" the first time
  // `moat` was run under the codex runtime.
  assert.equal(interactiveTerm("xterm-256color"), "xterm-256color")
  assert.equal(interactiveTerm("screen.xterm-256color"), "screen.xterm-256color")
  assert.equal(interactiveTerm("dumb"), "xterm-256color", "dumb is what we are replacing")
  assert.equal(interactiveTerm(undefined), "xterm-256color")
  assert.equal(interactiveTerm(""), "xterm-256color")
  assert.equal(interactiveTerm("  "), "xterm-256color")
  assert.equal(interactiveTerm("xterm\nEVIL=1"), "xterm-256color", "no whitespace reaches the box")
  assert.equal(interactiveTerm("a=b"), "xterm-256color")
})

test("a non-interactive boot still gets TERM=dumb", () => {
  // The sanitised value is for the interactive path only: a check or a server has no
  // terminal, and pretending otherwise would change the environment the suites measure.
  assert.equal(sandboxEnv().TERM, "dumb")
  assert.equal(sandboxEnv({ TERM: "xterm" }).TERM, "xterm", "callers can override explicitly")
})
