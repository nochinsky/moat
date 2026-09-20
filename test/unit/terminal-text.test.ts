import assert from "node:assert/strict"
import { test } from "node:test"

import { stripAnsi } from "../../lib/terminal.ts"

const ESC = "\u001b"

test("stripAnsi removes the sequences a terminal would act on", () => {
  assert.equal(stripAnsi("plain text"), "plain text")
  assert.equal(stripAnsi(`${ESC}[2J`), "", "erase display")
  assert.equal(stripAnsi(`${ESC}[31mred${ESC}[0m`), "red", "colour")
  assert.equal(stripAnsi(`${ESC}]0;pwned\u0007`), "", "window title (OSC, BEL-terminated)")
  assert.equal(stripAnsi(`${ESC}]52;c;cGF3bmVk${ESC}\\`), "", "clipboard write (OSC, ST-terminated)")
  assert.equal(stripAnsi("a\rb"), "ab", "a carriage return overwrites the row")
  assert.equal(stripAnsi("a\u0000\u0007b"), "ab", "other control characters")
  assert.equal(stripAnsi(`before ${ESC}[2J after`), "before  after", "the text around it survives")
})

test("a sequence split across two deltas cannot be reassembled", () => {
  // The bug: the answer is streamed in deltas, and a sequence can arrive in two
  // pieces. Neither piece is a sequence on its own, so a stripper that only removed
  // whole sequences would let the terminal read the halves joined back together.
  const attacks = [`${ESC}[2J`, `${ESC}]0;pwned\u0007`, `${ESC}]52;c;cGF3bmVk${ESC}\\`, `${ESC}[1;1H`, `${ESC}M`]
  for (const attack of attacks) {
    for (let cut = 1; cut < attack.length; cut++) {
      const first = stripAnsi(attack.slice(0, cut))
      const second = stripAnsi(attack.slice(cut))
      // Every escape sequence starts with ESC, so "no ESC survives either half" is
      // the whole property: whatever the terminal receives cannot begin one.
      assert.equal(first.includes(ESC), false, `first half of ${JSON.stringify(attack)} cut at ${cut}`)
      assert.equal(second.includes(ESC), false, `second half of ${JSON.stringify(attack)} cut at ${cut}`)
    }
  }
})

// The end-to-end half — an escape sequence in the model's answer never reaching the terminal —
// is asserted on bytes in test/e2e-codex.sh, where a scripted answer carries the sequences and
// the captured output must contain no ESC at all. This file pins the stripper every print site
// uses, including the property that makes a split sequence safe.
