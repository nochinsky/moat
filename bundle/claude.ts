import { describeTurn, type ToolRun, type Turn, type Usage } from "./turn.ts"

/**
 * The Claude Code runtime: `claude -p --output-format stream-json`.
 *
 * Only the parser lives here so far. The rest of the runtime — the body script, the config and
 * brief, the tool allowlist — is rendered by `cmd/main.ts` and the runtime seam, and
 * `docs/RUNTIMES.md` carries the measurements this is written against (a real turn through a
 * keyless stub, captured, not read from a summary).
 *
 * The stream is newline-delimited JSON: `system/init`, then `assistant` and `user` events as the
 * turn proceeds, then one `result`. Each assistant event carries one content block — `text`,
 * `tool_use` or `thinking` — and each `user` event carries the `tool_result` for a `tool_use`
 * already seen, which is how a tool row is completed.
 *
 * Two things here are Claude-specific and would be wrong if copied from Codex:
 *
 *  - **`usage.input_tokens` does NOT include the cached tokens.** Anthropic reports
 *    `cache_read_input_tokens` and `cache_creation_input_tokens` as separate fields, so the miss
 *    count *is* `input_tokens` and subtracting the cache would undercount. Codex's Responses field
 *    is the opposite and moat subtracts there; `bundle/turn.ts` says why the normalisation lives in
 *    each parser rather than in the footer.
 *  - **`output_tokens` is documented as including thinking tokens**, which arrive separately in
 *    `output_tokens_details.thinking_tokens`. `Turn` prices output and reasoning separately, so
 *    reasoning is lifted out of output rather than counted twice. Measured caveat: the captured
 *    turn had `thinking_tokens: 0`, which proves nothing about the overlap; the mapping is pinned
 *    in `test/unit/claude-runtime.test.ts` so a real measuring turn can flip it in one place.
 *
 * `permission_denials` on the `result` event is the reason moat can keep invariant 3 without
 * `--dangerously-skip-permissions` (which Claude Code refuses as root): the renderer allows the
 * tools the agent needs, and this field is the *reading* that says whether anything was blocked.
 * Denials become notices, because a denial does not fail the turn but a user has to be able to see
 * it — an agent quietly unable to run a command is the failure mode being guarded against.
 */

/** Non-fatal advisories that wear an error's clothes, as with Codex's metadata notice. */
function isNotice(message: string): boolean {
  return /^Model metadata for .* not found/.test(message)
}

function numberField(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

/** The thing a tool item is *about*, for the one-line row a footer prints. */
function detailOf(input: Record<string, unknown>, name: string): string {
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "prompt"]) {
    const value = input[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return name
}

/** One `claude -p --output-format stream-json` document, in the shape the CLI prints it. */
export function parseClaudeEvents(text: string): Turn {
  const turn: Turn = { tools: [], messages: [], usage: null, errors: [], notices: [] }
  const byId = new Map<string, ToolRun>()
  // The `result` event's usage is the whole turn's; per-assistant usage is per-request, so it is
  // only a fallback for a stream that ended before a `result` arrived.
  let fallback: Usage = { input: 0, cached: 0, output: 0, reasoning: 0 }
  let sawFallbackUsage = false

  for (const raw of text.split("\n")) {
    const line = raw.trim()
    // stderr is merged into the same capture by the launcher, so a non-JSON line is expected
    // rather than exceptional. Unknown events are ignored, never guessed at.
    if (line.length === 0 || !line.startsWith("{")) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    const type = event.type

    if (type === "assistant") {
      const message = asRecord(event.message)
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const item = asRecord(block)
        if (item.type === "text" && typeof item.text === "string") {
          if (item.text.length > 0) turn.messages.push(item.text)
        } else if (item.type === "tool_use") {
          const id = typeof item.id === "string" ? item.id : `tool-${turn.tools.length}`
          const name = typeof item.name === "string" ? item.name : "tool"
          const row: ToolRun = { id, kind: name, detail: detailOf(asRecord(item.input), name), status: "started" }
          byId.set(id, row)
          turn.tools.push(row)
        }
        // `thinking` is not prose and is not shown; it is priced through usage, not messages.
      }
      // An API-level failure (auth, rate limit) arrives as an assistant block of prose plus these
      // fields. It is a real error, unlike the metadata notice Codex emits.
      const error = typeof message.error === "string" ? message.error : null
      if (error !== null) {
        const prose = turn.messages.length > 0 ? turn.messages[turn.messages.length - 1]! : error
        turn.errors.push(isNotice(prose) ? error : `${error}: ${prose}`)
      }
      const usage = asRecord(message.usage)
      if (Object.keys(usage).length > 0) {
        sawFallbackUsage = true
        const thinking = numberField(asRecord(usage.output_tokens_details), "thinking_tokens")
        fallback = {
          input: fallback.input + numberField(usage, "input_tokens"),
          cached: fallback.cached + numberField(usage, "cache_read_input_tokens"),
          output: fallback.output + Math.max(0, numberField(usage, "output_tokens") - thinking),
          reasoning: fallback.reasoning + thinking,
        }
      }
      continue
    }

    if (type === "user") {
      const message = asRecord(event.message)
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const item = asRecord(block)
        if (item.type !== "tool_result") continue
        const id = typeof item.tool_use_id === "string" ? item.tool_use_id : ""
        const row = byId.get(id)
        if (!row) continue
        row.status = "completed"
        // `is_error` is the tool's verdict; the `Turn` shape carries it as an exit code so the
        // footer's "N failed" counts a failed command the same way it does under Codex.
        row.exitCode = item.is_error === true ? 1 : 0
      }
      continue
    }

    if (type === "result") {
      const usage = asRecord(event.usage)
      const thinking = numberField(asRecord(usage.output_tokens_details), "thinking_tokens")
      if (Object.keys(usage).length > 0) {
        sawFallbackUsage = false
        turn.usage = {
          input: numberField(usage, "input_tokens"),
          cached: numberField(usage, "cache_read_input_tokens"),
          output: Math.max(0, numberField(usage, "output_tokens") - thinking),
          reasoning: thinking,
        }
      }
      for (const denial of Array.isArray(event.permission_denials) ? event.permission_denials : []) {
        const item = asRecord(denial)
        const name = typeof item.tool_name === "string" ? item.tool_name : "a tool"
        turn.notices.push(`permission denied: ${name} (the allowlist is missing it, so the agent was blocked)`)
      }
      if (event.is_error === true) {
        const reason =
          typeof event.terminal_reason === "string" ? event.terminal_reason : typeof event.subtype === "string" ? event.subtype : "error"
        const prose = typeof event.result === "string" && event.result.length > 0 ? event.result : reason
        turn.errors.push(`${reason}: ${prose}`)
      }
    }
    // Every other event type — `system/init`, and anything a newer CLI adds — is ignored.
  }

  if (turn.usage === null && sawFallbackUsage) turn.usage = fallback
  return turn
}

export const describeClaudeTurn = describeTurn
