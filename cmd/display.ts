/**
 * How moat's session looks.
 *
 * Kept apart from the session loop for one reason: everything here is a pure
 * function of text and a theme, so it can be tested by calling it, without a
 * terminal, a sandbox or a model. The parts that genuinely need a terminal —
 * the live spinner, the input line, cursor handling — stay in repl.ts.
 *
 * Two decisions worth stating.
 *
 * COLOUR IS OPT-IN, NOT OPT-OUT. A pipe, a `NO_COLOR`, or a `TERM=dumb` gets
 * plain text. That matters more here than in most tools because moat's own test
 * suite reads this output through a pty and asserts on it, and escape codes
 * that leak into a non-terminal are the classic way that goes wrong.
 *
 * MARKDOWN IS RENDERED PER LINE, NOT PER TOKEN. Styling cannot be applied
 * retroactively to text already written to a terminal, and half a `**bold**`
 * marker is worse than none, so a line is styled once it is complete. The
 * trailing partial line is streamed raw so the session never looks stalled
 * (see AnswerRenderer.push).
 */

const ESC = "\u001b["

export type Theme = {
  enabled: boolean
  bold: (s: string) => string
  dim: (s: string) => string
  italic: (s: string) => string
  red: (s: string) => string
  green: (s: string) => string
  yellow: (s: string) => string
  cyan: (s: string) => string
  magenta: (s: string) => string
  grey: (s: string) => string
  /** Assistant prose gutter. */
  gutter: string
  /** Reasoning gutter, including the label. */
  thoughtGutter: string
}

/**
 * Whether to emit escape codes at all.
 *
 * `FORCE_COLOR` is honoured because the pty tests set it: a pty is a terminal,
 * but `TERM` may be unset in a container, and the tests want to check both the
 * plain and the coloured rendering.
 */
export function colourEnabled(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") return true
  if (process.env.TERM === "dumb") return false
  return stream.isTTY === true
}

export function makeTheme(enabled: boolean): Theme {
  const wrap = (code: string) => (s: string) => (enabled ? `${ESC}${code}m${s}${ESC}0m` : s)
  return {
    enabled,
    bold: wrap("1"),
    // Bright black (90), not faint (2). Faint is widely rendered as *nothing*
    // at all, which silently loses every piece of secondary information;
    // opencode's own line-mode UI uses 90 for the same reason.
    dim: wrap("90"),
    italic: wrap("3"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    cyan: wrap("36"),
    magenta: wrap("35"),
    grey: wrap("90"),
    gutter: enabled ? `${ESC}90m\u2502${ESC}0m ` : "\u2502 ",
    thoughtGutter: enabled ? `${ESC}90m\u2502${ESC}0m ${ESC}36mthinking${ESC}0m ` : "\u2502 thinking ",
  }
}

/**
 * Remove escape sequences from text moat did not produce.
 *
 * Tool output comes from arbitrary programs, and a stray `\r`, cursor-up or
 * colour change will corrupt the transcript around it. Everything the agent
 * prints is passed through here first. Escape sequences are dropped rather than
 * escaped so that, for example, a test runner's coloured output reads as plain
 * text instead of arriving as literal `[32m` noise.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "") // OSC … BEL/ST
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\u001b[@-Z\\-_]/g, "") // other two-byte sequences
    .replace(/\r/g, "") // carriage returns overwrite the current row
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") // control chars
}

/** Truncate to a visible width, appending an ellipsis when something was cut. */
export function truncateVisible(text: string, width: number): string {
  if (width <= 1) return ""
  if (visibleWidth(text) <= width) return text
  let out = ""
  let used = 0
  for (const char of text.replace(/\u001b\[[0-9;]*m/g, "")) {
    if (used >= width - 1) break
    out += char
    used++
  }
  return `${out}\u2026`
}

/**
 * A readable message from an opencode error value.
 *
 * The shape varies — a thrown Error, `{data:{message}}`, `{message}`, a bare
 * string — and `JSON.stringify` of the whole thing buries the one useful line
 * inside a wall of structure, which is what moat used to print.
 */
export function formatError(error: unknown): string {
  if (error === null || error === undefined) return "unknown error"
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  const value = error as { data?: { message?: unknown }; message?: unknown; name?: unknown; error?: unknown }
  if (typeof value.data?.message === "string") return value.data.message
  if (typeof value.message === "string") return value.message
  if (typeof value.error === "string") return value.error
  if (typeof value.name === "string") return value.name
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Frames for the busy indicator, matching opencode's set. */
export const SPINNER_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"]

export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!
}

/** Visible width, ignoring escape sequences. */
export function visibleWidth(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length
}

/**
 * Pad to a column, counting only what is visible, so a styled cell does not
 * push the next column out by the length of its escape codes.
 */
export function padTo(text: string, width: number): string {
  const pad = width - visibleWidth(text)
  return pad > 0 ? text + " ".repeat(pad) : text
}

/**
 * Inline markdown, applied to one line.
 *
 * Deliberately small: bold, inline code, and links. Anything more and the
 * failure mode stops being "slightly plain text" and starts being "mangled
 * code sample", which is the one thing a coding agent must not do.
 */
export function inline(text: string, theme: Theme): string {
  // Without colour the markers still have to go: leaving literal `**` and
  // backticks in the answer is worse than losing the emphasis.
  if (!theme.enabled) {
    return text
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
  }
  return text
    .replace(/`([^`]+)`/g, (_m, code: string) => theme.cyan(code))
    .replace(/\*\*([^*]+)\*\*/g, (_m, body: string) => theme.bold(body))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => `${label} ${theme.dim(`(${url})`)}`)
}

export type MarkdownState = {
  /** Inside a fenced code block. */
  fence: boolean
  /** The fence's language, for the block header. */
  language: string
}

export function newMarkdownState(): MarkdownState {
  return { fence: false, language: "" }
}

/**
 * Render one complete line of assistant output.
 *
 * Block constructs are handled here, inline ones by `inline()`. Code blocks are
 * left completely alone apart from indentation — a coding agent that
 * reformats the code it is showing you is worse than one that shows it plainly.
 */
export function renderLine(line: string, theme: Theme, state: MarkdownState): string {
  const fence = /^\s*(?:```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/.exec(line)

  if (state.fence) {
    if (fence) {
      state.fence = false
      state.language = ""
      return theme.dim("  \u2514\u2500") // closes the block
    }
    return theme.dim("  \u2502 ") + theme.dim(line)
  }

  if (fence && line.trim() !== "") {
    state.fence = true
    state.language = fence[1] ?? ""
    const label = state.language ? ` ${theme.dim(state.language)}` : ""
    return theme.dim("  \u250c\u2500") + label
  }

  // A blank line stays blank. Emitting the answer's indent here would leave
  // trailing whitespace on every paragraph break.
  if (line.trim() === "") return ""

  // A heading: `#`, `##`, …
  const heading = /^(#{1,6})\s+(.*)$/.exec(line)
  if (heading) {
    const level = heading[1]!.length
    const body = inline(heading[2]!, theme)
    return `  ${theme.bold(level <= 2 ? body : theme.dim(body))}`
  }

  // A horizontal rule, often used to separate sections.
  if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) return theme.dim(`  ${"\u2500".repeat(24)}`)

  // Bullets, at any indent, with each level marked differently.
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
  if (bullet) {
    const depth = Math.floor(bullet[1]!.length / 2)
    const mark = depth === 0 ? "\u2022" : depth === 1 ? "\u25e6" : "\u00b7"
    return `${"  ".repeat(depth + 1)}${theme.dim(mark)} ${inline(bullet[2]!, theme)}`
  }

  // Numbered lists keep their numbers, which carry meaning.
  const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
  if (numbered) {
    const depth = Math.floor(numbered[1]!.length / 2)
    return `${"  ".repeat(depth + 1)}${theme.dim(`${numbered[2]}.`)} ${inline(numbered[3]!, theme)}`
  }

  // Blockquote.
  const quote = /^\s*>\s?(.*)$/.exec(line)
  if (quote) return `  ${theme.dim(`\u2502 ${inline(quote[1]!, theme)}`)}`

  return `  ${inline(line, theme)}`
}

/**
 * Streams assistant text a line at a time.
 *
 * The subtlety is the partial line. Styling has to wait for a complete line,
 * but waiting for the newline before showing *anything* makes a long paragraph
 * look like a hang. So a partial line is streamed raw, and once it is long
 * enough that a user would notice its absence (PARTIAL_LIMIT), it is shown as
 * it arrives and simply stays unstyled — the alternative is rewriting a line
 * that may have wrapped, which corrupts the display.
 */
export class AnswerRenderer {
  private buffer = ""
  /** Set once the current line has been streamed raw; it cannot be styled now. */
  private raw = false
  private readonly state = newMarkdownState()
  /** True while an answer block is open, so callers know whether to end it. */
  open = false

  // Plain fields rather than constructor parameter properties: moat runs on
  // Node's native type stripping, which erases types but cannot desugar them.
  private readonly theme: Theme
  private readonly write: (text: string) => void
  private readonly gutter: string

  constructor(theme: Theme, write: (text: string) => void, gutter?: string) {
    this.theme = theme
    this.write = write
    this.gutter = gutter ?? theme.gutter
  }

  private static readonly PARTIAL_LIMIT = 160
  /** True until the block's first line has been written. */
  private first = true
  /** True once the current line has been written raw, so it must not be re-rendered. */
  private streamed = false

  /** Start a block. The gutter is written per line, by whoever writes the line. */
  private begin(): void {
    if (this.open) return
    this.open = true
    this.first = true
    this.streamed = false
  }

  /** Write one already-complete line, gutter and all. */
  private emit(line: string): void {
    this.begin()
    const rendered = renderLine(line, this.theme, this.state)
    // A blank line keeps the gutter but not the space after it, so the answer
    // does not leave a trail of trailing whitespace when it is copied.
    const body = rendered === "" ? this.gutter.trimEnd() : this.gutter + rendered
    this.write((this.first ? "" : "\n") + body)
    this.first = false
  }

  push(delta: string): void {
    // The answer and the reasoning are the model's words, and the model is no
    // more trusted than the tools it runs: an escape sequence in an answer can
    // clear the screen, move the cursor, retitle the window or (where the
    // terminal allows it) set the clipboard, and a `\r` can overwrite the line.
    // Tool output was already stripped at its own boundary; this is the same
    // rule for the answer. Stripping a delta is safe against a sequence split
    // across two deltas: `stripAnsi` removes every ESC byte either as part of a
    // sequence or as a control character, so nothing can be reassembled on
    // screen. `test/unit/terminal-text.test.ts` and extras section V hold it there.
    this.buffer += stripAnsi(delta)
    let index = this.buffer.indexOf("\n")
    while (index !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)

      if (this.streamed) {
        // This line already went out raw. All that is left is to end it; the
        // text on screen cannot be restyled, so it is not re-rendered.
        this.streamed = false
        this.first = false
        this.write("\n")
      } else {
        this.emit(line)
      }
      index = this.buffer.indexOf("\n")
    }
    if (this.buffer.length === 0) return

    // No newline yet. Styling has to wait for a complete line, but waiting for
    // the newline before showing *anything* makes a long paragraph look like a
    // hang, so once the partial line is long enough to be noticeable it is
    // written as-is and stays plain. The alternative — rewriting the line once
    // it completes — cannot be done safely, because a line that wrapped past
    // the terminal width cannot be erased by column arithmetic.
    if (!this.streamed && this.buffer.length > AnswerRenderer.PARTIAL_LIMIT) {
      this.begin()
      this.write((this.first ? "" : "\n") + this.gutter + this.buffer)
      this.first = false
      this.streamed = true
      this.buffer = ""
    }
  }

  /** End the block, flushing whatever partial line is left. */
  flush(): void {
    if (this.buffer.length > 0) {
      if (this.streamed) {
        this.streamed = false
        this.first = false
      } else {
        this.emit(this.buffer)
      }
      this.buffer = ""
    }
    this.streamed = false
    this.state.fence = false
    this.state.language = ""
    if (!this.open) return
    this.write("\n")
    this.open = false
    this.first = true
  }
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export type ToolCallView = {
  tool: string
  status: string
  title?: string
  /** Milliseconds, when known. */
  ms?: number
  /** Line counts for an edit or a write, when known. */
  added?: number
  removed?: number
  /** First line of the error, when it failed. */
  error?: string
  /** Current spinner frame, while running. */
  spinner?: string
}

const TOOL_COLUMN = 10

/** `0.4s`, `12.3s`, or `2m 04s` when a call drags on. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`
}

/**
 * One line per tool call.
 *
 * Fixed columns so a long scroll of calls reads as a table rather than as
 * prose: mark, tool name, title, then the numbers on the right. The numbers are
 * what you scan for — a `+12 -1` next to `edit` says more than the title does.
 *
 * `width` is the terminal width, and the title is truncated to fit it. That is
 * not cosmetic: a running call's row is repainted in place, and repainting a row
 * that wrapped onto a second line corrupts the display below it. Keeping the row
 * to one terminal line is what makes the repaint safe, so the truncation is
 * applied to the plain title before any styling is added and never splits an
 * escape sequence.
 */
export function toolLine(call: ToolCallView, theme: Theme, width = 100): string {
  const mark =
    call.status === "completed"
      ? theme.green("\u2713")
      : call.status === "error"
        ? theme.red("\u2717")
        : theme.dim(call.spinner ?? "\u00b7")

  const name = call.status === "running" ? theme.dim(call.tool) : call.tool
  const plainTitle = stripAnsi((call.title ?? "").split("\n")[0] ?? "")

  const counts: string[] = []
  if (call.added !== undefined && call.added > 0) counts.push(theme.green(`+${call.added}`))
  if (call.removed !== undefined && call.removed > 0) counts.push(theme.red(`-${call.removed}`))
  if (call.ms !== undefined && call.status !== "running") counts.push(theme.dim(formatDuration(call.ms)))
  const tail = counts.join(" ")

  // "  " + mark + " " + padded name, then the title, then the tail flush right.
  const nameColumn = Math.max(TOOL_COLUMN, visibleWidth(call.tool))
  const headWidth = 2 + 1 + 1 + nameColumn + 1
  const tailWidth = visibleWidth(tail)
  // The tail is the column you scan down — durations, and how much an edit
  // changed — so it is right-aligned rather than left to trail the title at
  // whatever column the title happened to end on.
  const room = width - 1 - headWidth - tailWidth - (tail ? 2 : 0)
  const title = plainTitle === "" || room < 8 ? "" : truncateVisible(plainTitle, room)

  const head = `  ${mark} ${padTo(name, nameColumn)} `
  if (tail === "") return `${head}${theme.dim(title)}`.trimEnd()

  const gap = " ".repeat(Math.max(2, room - visibleWidth(title) + 2))
  return `${head}${theme.dim(title)}${gap}${tail}`.trimEnd()
}

/**
 * The lines of an edit, as a diff.
 *
 * Common leading and trailing lines are dropped and the remainder shown, which
 * is what an `edit` call actually is — one contiguous replacement. A real diff
 * algorithm would be worse here: it would find spurious matches inside a
 * two-line change and make it harder to read, not easier.
 */
export function editDiff(
  oldText: string | undefined,
  newText: string | undefined,
  theme: Theme,
  limit = 12,
): { lines: string[]; added: number; removed: number } {
  const oldLines = (oldText ?? "").split("\n")
  const newLines = (newText ?? "").split("\n")

  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++
  let endOld = oldLines.length
  let endNew = newLines.length
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--
    endNew--
  }

  const removed = oldLines.slice(start, endOld)
  const added = newLines.slice(start, endNew)
  const lines: string[] = []
  for (const line of removed.slice(0, limit)) lines.push(`      ${theme.red(`- ${line}`)}`)
  for (const line of added.slice(0, limit)) lines.push(`      ${theme.green(`+ ${line}`)}`)
  const hidden = removed.length + added.length - lines.length
  if (hidden > 0) lines.push(`      ${theme.dim(`\u2026 ${hidden} more line(s)`)}`)

  return { lines, added: added.length, removed: removed.length }
}

/** Tool output, indented and capped, with the number of hidden lines stated. */
export function outputLines(output: string, theme: Theme, limit = 12): string[] {
  const lines = output.trimEnd().split("\n")
  const shown = lines.slice(0, limit).map((line) => `      ${theme.dim(line)}`)
  if (lines.length > limit) shown.push(`      ${theme.dim(`\u2026 ${lines.length - limit} more line(s)`)}`)
  return shown
}

// ---------------------------------------------------------------------------
// Turn summary
// ---------------------------------------------------------------------------

export type TurnSummary = {
  promptTokens: number
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number
  usd: number
  costKnown: boolean
  peak: boolean
  tools: number
  failed: number
  ms: number
  /** Context window, if known, for the usage proportion. */
  contextLimit?: number
}

/** `8.9k`, `1.0M` — imported shape kept local so this file has no deps. */
function short(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}k`
  return String(count)
}

function money(amount: number): string {
  if (amount === 0) return "$0.00"
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  if (amount < 10) return `$${amount.toFixed(3)}`
  return `$${amount.toFixed(2)}`
}

/**
 * The line printed under a turn.
 *
 * This is the honest version of the numbers: the token split distinguishes
 * cached from uncached input because the price difference is 30x, the reasoning
 * tokens are shown separately because they are billed as output and are
 * otherwise invisible, and the rate is named because the same turn costs twice
 * as much at peak.
 */
export function turnSummaryLine(summary: TurnSummary, theme: Theme): string {
  const parts: string[] = []
  parts.push(`${short(summary.promptTokens)} in`)
  if (summary.cachedTokens > 0) parts.push(theme.dim(`${short(summary.cachedTokens)} cached`))
  parts.push(`${short(summary.outputTokens)} out`)
  if (summary.reasoningTokens > 0) parts.push(theme.dim(`${short(summary.reasoningTokens)} reasoning`))
  parts.push(summary.tools === 1 ? "1 tool" : `${summary.tools} tools`)
  if (summary.failed > 0) parts.push(theme.red(`${summary.failed} failed`))
  parts.push(formatDuration(summary.ms))

  const right = summary.costKnown ? `${money(summary.usd)} ${theme.dim(summary.peak ? "peak" : "off-peak")}` : "cost unknown"

  const line = `  ${theme.dim("\u2500")} ${theme.dim(parts.join(" \u00b7 "))}`

  if (summary.contextLimit && summary.contextLimit > 0) {
    const used = summary.promptTokens + summary.outputTokens
    const pct = (used / summary.contextLimit) * 100
    const shown = pct < 1 ? "<1%" : `${Math.round(pct)}%`
    return `${line}  ${theme.dim(`${shown} of context`)}  ${right}`
  }
  return `${line}  ${right}`
}

export { money as formatMoney, short as formatCount }
