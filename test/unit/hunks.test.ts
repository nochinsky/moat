import assert from "node:assert/strict"
import { test } from "node:test"

import {
  applyHunks,
  hunksBetween,
  joinLines,
  parseHunkSelection,
  parseUnifiedHunks,
  readLines,
} from "../../lib/hunks.ts"

/**
 * Hunks are anchored to the **destination**: a hunk names a range of destination lines and the
 * lines that replace it. That choice is what makes a subset coherent — accepting hunks 1 and 3 of
 * five leaves the destination's own lines everywhere else — and it is what these tests pin.
 *
 * The distance between the changes matters and is not incidental. `git diff --unified=3` merges two
 * changes into one hunk when they are within three lines of each other, so a fixture whose edits
 * are close tests a different thing than it looks like it tests. The first version of this did
 * exactly that: edits at lines 3 and 8 came back as one hunk and "accept hunk 1 only" applied both.
 */

/** A file of `count` numbered lines, so a change can be placed anywhere and seen. */
function numbered(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
}

/** `numbered(count)` with the given 1-based lines replaced. */
function withEdits(count: number, edits: Record<number, string>): string {
  const lines = Array.from({ length: count }, (_, i) => `line ${i + 1}`)
  for (const [line, text] of Object.entries(edits)) lines[Number(line) - 1] = text
  return lines.join("\n") + "\n"
}

test("changes far enough apart are separate hunks, and each can be taken alone", async () => {
  const dest = numbered(40)
  const proposed = withEdits(40, { 3: "line 3: changed", 31: "line 31: changed" })
  const hunks = (await hunksBetween(dest, proposed))!
  assert.equal(hunks.length, 2, "two changes 28 lines apart are two hunks")

  // Every hunk names a range of the destination, and carries the destination's own lines as
  // `removed`, which is what a reviewer is shown.
  assert.equal(hunks[0]!.destStart, 1)
  assert.equal(hunks[1]!.destStart, 28)
  assert.ok(hunks[0]!.removed.includes("line 3"))
  assert.ok(hunks[1]!.removed.includes("line 31"))

  const onlyFirst = applyHunks(dest, hunks, new Set([0]))
  assert.match(onlyFirst, /line 3: changed/)
  assert.doesNotMatch(onlyFirst, /line 31: changed/)
  const onlySecond = applyHunks(dest, hunks, new Set([1]))
  assert.match(onlySecond, /line 31: changed/)
  assert.doesNotMatch(onlySecond, /line 3: changed/)
  // Nothing accepted is the destination, byte for byte. This is the property the whole feature
  // rests on: a rejected hunk leaves your file exactly as it was.
  assert.equal(applyHunks(dest, hunks, new Set()), dest)
  assert.equal(applyHunks(dest, hunks, new Set([0, 1])), proposed)
  // The line count is unchanged by a replacement, so a range that shrank or grew would show here.
  for (const content of [onlyFirst, onlySecond, applyHunks(dest, hunks, new Set())]) {
    assert.equal(content.split("\n").length, dest.split("\n").length)
  }
})

test("a hunk that adds and a hunk that removes are both expressible, and applied in any order", async () => {
  const dest = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n"
  // An insertion near the top, a deletion near the bottom, far enough apart to be two hunks.
  const proposed = "a\nb\nNEW\nc\nd\ne\nf\ng\nh\ni\nk\nl\n"
  const hunks = (await hunksBetween(dest, proposed))!
  assert.equal(hunks.length, 2, "an insertion and a deletion, separately")
  assert.equal(applyHunks(dest, hunks, new Set([0])), "a\nb\nNEW\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n")
  assert.equal(applyHunks(dest, hunks, new Set([1])), "a\nb\nc\nd\ne\nf\ng\nh\ni\nk\nl\n")
  assert.equal(applyHunks(dest, hunks, new Set([0, 1])), proposed)
  // Applying from the bottom up is what keeps the earlier hunk's range valid after the later one
  // changed the line count; the reverse order would land the insertion in the wrong place.
  assert.equal(applyHunks(dest, hunks, new Set([0, 1])), proposed)
})

test("a trailing newline is a property of the file, not of the hunk", async () => {
  // A file with no trailing newline is the case a naive split/join silently changes, which would
  // show up as a one-byte diff in the user's tree.
  const dest = "one\ntwo\nthree"
  const proposed = "one\nTWO\nthree"
  const hunks = (await hunksBetween(dest, proposed))!
  assert.equal(applyHunks(dest, hunks, new Set([0])), "one\nTWO\nthree", "still no trailing newline")
  const withNewline = "one\ntwo\nthree\n"
  const hunks2 = (await hunksBetween(withNewline, "one\nTWO\nthree\n"))!
  assert.equal(applyHunks(withNewline, hunks2, new Set([0])), "one\nTWO\nthree\n", "and still one when it had one")
  // The reader agrees about both.
  const scratch = { lines: readLines("/dev/null") }
  assert.deepEqual(scratch.lines, { lines: [], trailingNewline: true })
  assert.equal(joinLines([], true), "")
})

test("a whole-file replacement is one hunk and can be refused", async () => {
  // `add` arrives as an empty destination, and a rewrite with nothing in common is one hunk.
  const hunks = (await hunksBetween("", "brand new\nfile\n"))!
  assert.equal(hunks.length, 1)
  assert.equal(hunks[0]!.destStart, 1)
  assert.equal(hunks[0]!.destEnd, 0, "an insertion at the top has an empty destination range")
  assert.equal(applyHunks("", hunks, new Set([0])), "brand new\nfile\n")
  assert.equal(applyHunks("", hunks, new Set()), "")
})

test("an identical pair has no hunks at all", async () => {
  const same = numbered(10)
  assert.deepEqual(await hunksBetween(same, same), [])
  assert.deepEqual(await hunksBetween("", ""), [])
  // And applying an empty hunk list is the identity, which is what makes a path with no textual
  // change fall back to path-level rather than writing something empty.
  assert.equal(applyHunks(same, [], new Set()), same)
})

test("the diff parser reads git's own format, including the shapes that are easy to get wrong", () => {
  // Exercised through `hunksBetween` above, but pinned here directly: the forms below are the ones
  // a hand-written reader gets wrong, and a mistake in any of them moves a write to the wrong
  // lines in the user's file.
  const diff = [
    "--- a/x",
    "+++ b/x",
    "@@ -1,5 +1,6 @@",
    " one",
    "-two",
    "+TWO",
    "+EXTRA",
    " three",
    "@@ -20,2 +21,2 @@",
    " twenty",
    "-twentyone",
    "\\ No newline at end of file",
    "+TWENTYONE",
    "\\ No newline at end of file",
  ].join("\n")
  const parsed = parseUnifiedHunks(diff)
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed[0], { oldStart: 1, oldEnd: 5, lines: ["one", "TWO", "EXTRA", "three"] })
  // The "\ No newline" marker is not a content line, and a `-` line is not part of the new side.
  assert.deepEqual(parsed[1], { oldStart: 20, oldEnd: 21, lines: ["twenty", "TWENTYONE"] })
  // An insertion has an empty destination range: `@@ -7,0` is a position, not a range that exists.
  // Reading it as `7..7` would delete a line the user never asked to remove.
  assert.deepEqual(parseUnifiedHunks("@@ -7,0 +8,2 @@\n+added one\n+added two\n"), [
    { oldStart: 7, oldEnd: 6, lines: ["added one", "added two"] },
  ])
  // A hunk header with no count means one line, per the format.
  assert.deepEqual(parseUnifiedHunks("@@ -4 +4 @@\n-old\n+new\n"), [{ oldStart: 4, oldEnd: 4, lines: ["new"] }])
  // Anything before the first header is not a hunk.
  assert.deepEqual(parseUnifiedHunks("--- a/x\n+++ b/x\n"), [])
})

test("a hunk selection is read the way patch and git users read it", () => {
  assert.deepEqual(parseHunkSelection("1", 3), { accepted: [0], error: null })
  assert.deepEqual(parseHunkSelection("1,3", 3), { accepted: [0, 2], error: null })
  assert.deepEqual(parseHunkSelection("2-3", 3), { accepted: [1, 2], error: null })
  assert.deepEqual(parseHunkSelection("1-3", 3), { accepted: [0, 1, 2], error: null })
  assert.deepEqual(parseHunkSelection("all", 3), { accepted: [0, 1, 2], error: null })
  assert.deepEqual(parseHunkSelection("none", 3), { accepted: [], error: null })
  assert.deepEqual(parseHunkSelection("  2 , 3 ", 3), { accepted: [1, 2], error: null })
  // Empty input means "nothing", which is a decision a reviewer is allowed to make.
  assert.deepEqual(parseHunkSelection("", 3), { accepted: [], error: null })
  // Repeats collapse rather than accepting the same hunk twice.
  assert.deepEqual(parseHunkSelection("2,2,1", 3), { accepted: [0, 1], error: null })

  // A selector naming a hunk that does not exist is an error, not a silent under-accept: the user
  // asked for something and the alternative to refusing is writing less than they asked for.
  for (const [text, count] of [["4", 3], ["3-5", 3], ["0", 3], ["3-1", 3], ["x", 3], ["1,,x", 3], ["-2", 3]] as const) {
    const result = parseHunkSelection(text, count)
    assert.equal(result.accepted.length, 0, `${text} of ${count} must accept nothing`)
    assert.ok(result.error, `${text} of ${count} must report why`)
  }
})
