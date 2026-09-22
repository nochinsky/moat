import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import { run } from "./shell.ts"
import { SANITIZED_GIT_ENV } from "./git.ts"

/**
 * Per-hunk review of a planned change.
 *
 * `planApply` decides *which files* a merge would change and how. That is the decision the
 * product is built on, and until this file existed it was also the smallest decision the user
 * could make: `moat apply` wrote a file or skipped it. A file with one good change and one bad one
 * had to be taken or left whole.
 *
 * This turns each planned file into hunks and writes back only the ones that were accepted. The
 * classification is not recomputed here — the plan already said agent / you / both / conflict, and
 * `Changes` below is that answer in a shape a reviewer can act on.
 *
 * The design decision that matters is what a hunk is expressed *against*. Hunks are anchored to
 * the **destination** (the file's current content on the host, or the merged content for a change
 * the planner already merged): each hunk names a range of destination lines and the lines that
 * should replace it. Anchoring to the destination is what makes a subset coherent — accepting
 * hunks 1 and 3 of five leaves the destination's own lines everywhere else, so hunk 3's position
 * does not depend on whether hunk 2 was taken. Anchoring to the source would have made every later
 * hunk's offsets depend on the earlier decisions, which is a bug waiting to happen and a test that
 * cannot be written.
 *
 * Where the lines come from, per change kind:
 *
 *   add     dest = an empty file; the whole source is one hunk
 *   modify  dest = the host file; the source's changes are the hunks
 *   merge   dest = the *merged* bytes (which the planner produced from base/host/theirs); the
 *           hunks are what the merge changed about your file
 *
 * Everything else — `delete`, `mode`, `link` — is path-level: there is nothing to split, so a hunk
 * list of one that cannot be partially applied. `rejectAll` says so rather than pretending.
 */

export type Hunk = {
  /** 1-based, inclusive, into the destination content. */
  destStart: number
  destEnd: number
  /** The lines that replace `destStart..destEnd`. Empty means the range is removed. */
  lines: string[]
  /** For display: the destination lines this replaces. */
  removed: string[]
  /**
   * Set on the one hunk that reaches the end of the destination, and only there: whether the file
   * ends with a newline once that hunk is applied. Absent means the hunk does not touch the end, so
   * the destination's own ending stands.
   *
   * git writes a change to the final newline as the `\ No newline at end of file` marker attached
   * to the hunk that touches the last line, and `parseUnifiedHunks` drops that marker because it is
   * not a content line. Carrying the answer here instead is what keeps a *partial* accept honest:
   * taking the end-of-file hunk adopts the proposed ending, leaving it out keeps the destination's.
   * Everywhere else `applyHunks` kept the destination's ending, so accepting the agent's
   * end-of-file change could lose a one-byte difference from what the user reviewed — measured, and
   * the round-trip `applyHunks(dest, hunksBetween(dest, proposed), all) === proposed` failed on it.
   */
  eofNewline?: boolean
}

export type ReviewedChange = {
  path: string
  /** The planner's classification, carried through rather than re-derived. */
  verdict: "agent" | "you" | "both" | "conflict"
  kind: string
  /** The planner's own note, for the reviewer. */
  note?: string
  /** The file to read the proposed content from: frozen at plan time, outside the rootfs. */
  sourceFile?: string
  /** The file whose current content the hunks are anchored to, when it exists. */
  destFile?: string
  hunks: Hunk[]
  /** False for `delete`/`mode`/`link`: the change is not divisible. */
  partial: boolean
  /** True when the plan already refused this change; nothing here may write it. */
  conflict: boolean
}

/** Split a unified diff body into hunks: ranges in the *old* file and the lines that replace them. */
export function parseUnifiedHunks(diff: string): { oldStart: number; oldEnd: number; lines: string[] }[] {
  const hunks: { oldStart: number; oldEnd: number; lines: string[] }[] = []
  let current: { oldStart: number; oldEnd: number; lines: string[] } | null = null
  for (const raw of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (header) {
      const oldCount = header[2] === undefined ? 1 : Number(header[2])
      // A zero-length old side is an insertion, and `@@ -0,0` is how git writes "into an empty
      // file": the position is 0, which is not a line. Normalising it to 1 is what keeps
      // `splice(destStart - 1, 0, ...)` — index 0, the front of the file — rather than
      // `splice(-1, 0, ...)`, which inserts before the *last* line. Measured: the empty-file case
      // came back as `destStart: 0, destEnd: -1`, and `applyHunks("", ...)` then produced a
      // two-line file from a one-line insertion point.
      const oldStart = oldCount === 0 ? Math.max(1, Number(header[1])) : Number(header[1])
      current = { oldStart, oldEnd: oldCount === 0 ? oldStart - 1 : oldStart + oldCount - 1, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (raw.startsWith("\\")) continue // "\ No newline at end of file"
    if (raw.startsWith("+") || raw.startsWith(" ")) current.lines.push(raw.slice(1))
    // "-" lines are the old side; they are what the hunk removes, and are not part of `lines`.
  }
  return hunks
}

/** Read a file's lines, remembering whether it ended with a newline. */
export function readLines(file: string): { lines: string[]; trailingNewline: boolean } {
  if (!fs.existsSync(file)) return { lines: [], trailingNewline: true }
  const text = fs.readFileSync(file, "utf8")
  if (text.length === 0) return { lines: [], trailingNewline: true }
  const trailingNewline = text.endsWith("\n")
  const lines = (trailingNewline ? text.slice(0, -1) : text).split("\n")
  return { lines, trailingNewline }
}

/** Join lines back into content, preserving whether the original ended with a newline. */
export function joinLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return ""
  return lines.join("\n") + (trailingNewline ? "\n" : "")
}

/**
 * The hunks that turn `dest` into `proposed`, as ranges of `dest`.
 *
 * `git diff --no-index` rather than a hand-written diff: the output has to line up with what
 * `git merge-file` and the planner already decided, and a second diff implementation is a second
 * thing that can disagree with them. It is run through a *file*, never through a string capture,
 * because the content is agent-controlled and a binary file must not be decoded.
 *
 * Returns null when the diff cannot be produced (a binary file, or a git that refused), which the
 * caller reports rather than guessing at.
 */
export async function hunksBetween(dest: string, proposed: string): Promise<Hunk[] | null> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `moat-hunks-${process.pid}-`))
  const before = path.join(scratch, "before")
  const after = path.join(scratch, "after")
  try {
    fs.writeFileSync(before, dest)
    fs.writeFileSync(after, proposed)
    const result = await run(
      "git",
      ["-c", "core.attributesFile=/dev/null", "diff", "--no-index", "--no-color", "--unified=3", "--", before, after],
      { env: SANITIZED_GIT_ENV, allowFailure: true, cwd: scratch },
    )
    // `diff --no-index` exits 1 for "they differ", which is the normal case here.
    if (result.code !== 0 && result.code !== 1) return null
    const destLines = readLines(before).lines
    const hunks: Hunk[] = parseUnifiedHunks(result.stdout).map((hunk) => ({
      destStart: hunk.oldStart,
      destEnd: hunk.oldEnd,
      lines: hunk.lines,
      removed: destLines.slice(Math.max(0, hunk.oldStart - 1), hunk.oldEnd),
    }))
    // The last hunk in the list has the largest `destEnd`; if it reaches the destination's last
    // line, it is the one git would have hung the `\ No newline at end of file` marker on, so it is
    // the hunk whose acceptance decides the file's ending. `>=` rather than `===` because an empty
    // destination has zero lines and its single insertion hunk has `destEnd === 0`.
    const eof = hunks[hunks.length - 1]
    if (eof && eof.destEnd >= destLines.length) {
      eof.eofNewline = proposed.length === 0 ? true : proposed.endsWith("\n")
    }
    return hunks
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Rebuild the destination's content with only the accepted hunks applied.
 *
 * Hunks are applied highest-first so an earlier replacement cannot move a later hunk's range: the
 * ranges are all expressed against the original destination, and rewriting from the bottom up
 * leaves every not-yet-applied range untouched.
 *
 * The result is computed from the *destination's bytes* and the accepted hunks' lines. It never
 * re-reads the sandbox, and it never re-reads the destination: the caller passes the content it
 * verified, which is how the three-way re-check keeps holding under partial accept.
 *
 * The file's final newline is the one thing the destination's bytes do not decide. It follows
 * whichever hunk touches the end of the file (`Hunk.eofNewline`): accept that hunk and the file
 * ends the way the proposal ends, leave it out and your own ending is untouched. Applying *every*
 * hunk then reproduces `proposed` byte for byte, which is the round-trip `hunksBetween` owes.
 */
export function applyHunks(destContent: string, hunks: Hunk[], accepted: ReadonlySet<number>): string {
  const { lines, trailingNewline } = readLinesFrom(destContent)
  const ordered = hunks
    .map((hunk, index) => ({ hunk, index }))
    .filter(({ index }) => accepted.has(index))
    .sort((a, b) => b.hunk.destStart - a.hunk.destStart)
  let trailing = trailingNewline
  for (const { hunk } of ordered) {
    lines.splice(hunk.destStart - 1, hunk.destEnd - hunk.destStart + 1, ...hunk.lines)
    // At most one hunk reaches the end of the destination, so this is the accepted hunk's answer
    // when there is one and the destination's own ending when there is not.
    if (hunk.eofNewline !== undefined) trailing = hunk.eofNewline
  }
  return joinLines(lines, trailing)
}

/** `readLines` for content already in memory. */
function readLinesFrom(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text.length === 0) return { lines: [], trailingNewline: true }
  const trailingNewline = text.endsWith("\n")
  const lines = (trailingNewline ? text.slice(0, -1) : text).split("\n")
  return { lines, trailingNewline }
}

/**
 * Parse a hunk selection: `1,3-5` means hunks 1, 3, 4 and 5 (1-based, as they are printed).
 *
 * The syntax is deliberately the one `git` and `patch` users already read. An empty selection is
 * valid and means "none of them", which is a thing a reviewer is allowed to decide; a selection
 * that names a hunk the file does not have is an error, because the alternative is silently
 * accepting less than was asked for.
 */
export function parseHunkSelection(text: string, hunkCount: number): { accepted: number[]; error: string | null } {
  const accepted = new Set<number>()
  const trimmed = text.trim()
  if (trimmed.length === 0) return { accepted: [], error: null }
  if (trimmed === "all") return { accepted: Array.from({ length: hunkCount }, (_, i) => i), error: null }
  if (trimmed === "none") return { accepted: [], error: null }
  for (const part of trimmed.split(",")) {
    const piece = part.trim()
    if (piece.length === 0) continue
    const range = /^(\d+)(?:-(\d+))?$/.exec(piece)
    if (!range) return { accepted: [], error: `"${piece}" is not a hunk number or range like 2 or 2-4` }
    const from = Number(range[1])
    const to = range[2] === undefined ? from : Number(range[2])
    if (from < 1 || to < from) return { accepted: [], error: `"${piece}" is not a valid range` }
    for (let n = from; n <= to; n += 1) {
      if (n > hunkCount) return { accepted: [], error: `this file has ${hunkCount} hunk(s), so ${n} does not exist` }
      accepted.add(n - 1)
    }
  }
  return { accepted: [...accepted].sort((a, b) => a - b), error: null }
}
