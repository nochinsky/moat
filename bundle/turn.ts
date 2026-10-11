/** What the host learns from Pi's JSON stream. Usage input is misses, not cache hits. */
export type ToolRun = {
  id: string
  kind: string
  detail: string
  status: "started" | "completed"
  exitCode?: number | null
  output?: string
}

export type Usage = {
  input: number
  cached: number
  output: number
  /** Included in Pi output; split out here, never counted twice. */
  reasoning: number
}

export type Turn = {
  tools: ToolRun[]
  messages: string[]
  usage: Usage | null
  errors: string[]
  notices: string[]
  /** Models actually observed, so extension-driven switches cannot be priced as one model. */
  models?: string[]
}

export function describeTurn(turn: Turn): string {
  const failed = turn.tools.filter((tool) => tool.status === "completed" && (tool.exitCode ?? 0) !== 0).length
  const parts = [turn.tools.length === 1 ? "1 tool" : `${turn.tools.length} tools`]
  if (failed > 0) parts.push(`${failed} failed`)
  if (turn.errors.length > 0) parts.push(turn.errors.length === 1 ? "1 error" : `${turn.errors.length} errors`)
  return parts.join(" · ")
}
