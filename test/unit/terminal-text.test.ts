import assert from "node:assert/strict"
import { test } from "node:test"

import { AnswerRenderer, makeTheme, stripAnsi } from "../../cmd/display.ts"

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

test("an escape sequence in the model's answer never reaches the terminal", () => {
  // The bug, end to end at the renderer: the answer and the reasoning are the
  // model's words and were written to the terminal verbatim, while tool output was
  // already stripped. An answer could clear the screen, retitle the window or (where
  // the terminal allows it) write the clipboard. The theme is built with colour off,
  // so every escape byte in this output would have come from the model.
  const written: string[] = []
  const renderer = new AnswerRenderer(makeTheme(false), (text) => written.push(text))
  renderer.push(`careful ${ESC}]0;pwned\u0007 now\n`)
  renderer.push(`${ESC}[2Jall done`)
  renderer.flush()

  const out = written.join("")
  assert.equal(out.includes(ESC), false, `no escape byte may reach the terminal, got ${JSON.stringify(out)}`)
  assert.match(out, /careful/)
  assert.match(out, /all done/)
})

test("a sequence split across deltas is dropped, not reassembled", () => {
  const written: string[] = []
  const renderer = new AnswerRenderer(makeTheme(false), (text) => written.push(text))
  renderer.push("hello \u001b[")
  renderer.push("2Jworld")
  renderer.flush()

  const out = written.join("")
  assert.equal(out.includes(ESC), false)
  assert.match(out, /hello/)
  assert.match(out, /world/)
})
