/**
 * The payload contract every agent runtime lands in.
 *
 * `docs/SEAM.md` §2.3 names this shape as the contract a second runtime has to satisfy: tool rows,
 * the agent's prose, usage, real errors, and advisories that are *not* errors. It lived inside
 * `bundle/codex.ts` as `CodexTurn` while Codex was the only runtime. Naming it here is what lets a
 * second parser produce the same thing rather than a lookalike, and it is why the cost footer never
 * has to know which agent it is pricing — `lib/pricing.ts` reads this shape and only this shape.
 *
 * Three properties are load-bearing and are not incidental:
 *
 *  1. **Unknown event types are ignored, never guessed at.** A newer CLI must not make a parser
 *     invent rows.
 *  2. **`usage.input` is the cache-*miss* count.** The runtimes disagree about whether the raw
 *     field includes the cached tokens — Codex's Responses `input_tokens` *does*, Anthropic's
 *     `input_tokens` does *not* — so each parser normalises it here. Charging the raw Codex field
 *     double-counted a mostly-cached turn by about ten times (measured; `docs/HISTORY.md`), and a
 *     parser that subtracted for Claude would undercount the same way in reverse.
 *  3. **A notice is not an error.** An advisory on the error channel must not make a good turn read
 *     as a broken one.
 */

export type ToolRun = {
  id: string
  /** `command_execution`, `file_change`, `mcp_tool_call`, `reasoning`, … */
  kind: string
  /** The command, path or query the item carries. */
  detail: string
  status: "started" | "completed"
  exitCode?: number | null
}

export type Usage = {
  /** Cache-*miss* input tokens, the field opencode also calls `input`. */
  input: number
  /** Cache-hit input tokens. */
  cached: number
  output: number
  reasoning: number
}

export type Turn = {
  tools: ToolRun[]
  messages: string[]
  usage: Usage | null
  errors: string[]
  /**
   * Advisories that arrive on the same channel as errors but are not failures.
   *
   * Codex prints "Model metadata for <id> not found. Defaulting to fallback metadata" as an
   * `error` item on the first run in a fresh `~/.codex` — it is a cache miss, not a broken turn,
   * and counting it made a successful run read `1 error` in the footer (measured).
   */
  notices: string[]
}

/** The one-line summary a footer prints: tool and error counts, and nothing else. */
export function describeTurn(turn: Turn): string {
  const failed = turn.tools.filter((tool) => tool.status === "completed" && (tool.exitCode ?? 0) !== 0).length
  const parts = [turn.tools.length === 1 ? "1 tool" : `${turn.tools.length} tools`]
  if (failed > 0) parts.push(`${failed} failed`)
  if (turn.errors.length > 0) parts.push(turn.errors.length === 1 ? "1 error" : `${turn.errors.length} errors`)
  return parts.join(" · ")
}
