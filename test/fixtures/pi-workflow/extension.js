import fs from "node:fs"

// A representative unattended policy: confirmations belong to the interactive
// UI. Headless calls fail closed instead of waiting for a dialog that cannot exist.
export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    fs.appendFileSync("/opt/moat-workflow-sessions.jsonl", JSON.stringify({
      mode: ctx.mode, hasUI: ctx.hasUI, cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
      sessionId: ctx.sessionManager.getSessionId(),
      entries: ctx.sessionManager.getBranch().length,
      hostCanary: process.env.HOST_ONLY_MCP_CANARY ?? null,
    }) + "\n")
  })
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "mcp__docs__search_docs" || event.input.pattern !== "private*") return
    if (!ctx.hasUI) return { block: true, reason: "workflow: approval required; no UI in headless mode" }
    if (!await ctx.ui.confirm("Allow private document search?", "This workflow requires approval.")) {
      return { block: true, reason: "workflow: private search declined" }
    }
  })
}
