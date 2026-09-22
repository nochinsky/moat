import assert from "node:assert/strict"
import { test } from "node:test"

import { parseClaudeEvents } from "../../bundle/claude.ts"
import { describeTurn } from "../../bundle/turn.ts"

/**
 * A real Claude Code turn, captured.
 *
 * These are the events a `claude -p --output-format stream-json --verbose --permission-mode
 * acceptEdits --allowedTools Bash` turn produced against a keyless stub inside a real moat box
 * (`docs/RUNTIMES.md` has the run): init, prose, a `tool_use`, the `tool_result` that came back
 * from actually running the command, closing prose, and one `result`. Fields the parser does not
 * read are dropped for length; the values it does read are the captured ones.
 */
const CAPTURE = [
  { type: "system", subtype: "init", cwd: "/work", permissionMode: "acceptEdits", tools: ["Bash", "Edit", "Read"], apiKeySource: "none" },
  {
    type: "assistant",
    message: { content: [{ type: "text", text: "Running the check." }], usage: { input_tokens: 120, output_tokens: 0, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 } },
  },
  {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "toolu_stub_1", name: "Bash", input: { command: "echo stub-tool-ran", description: "prove the tool ran" } }],
      usage: { input_tokens: 120, output_tokens: 0, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 },
    },
  },
  { type: "user", message: { content: [{ tool_use_id: "toolu_stub_1", type: "tool_result", content: "stub-tool-ran", is_error: false }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "Done: the tool ran." }], usage: { input_tokens: 240, output_tokens: 0 } } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    total_cost_usd: 0.0026825,
    permission_denials: [],
    result: "Done: the tool ran.",
    stop_reason: "end_turn",
    usage: { input_tokens: 360, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 32, output_tokens_details: { thinking_tokens: 0 } },
  },
]
  .map((event) => JSON.stringify(event))
  .join("\n")

test("a captured Claude turn parses into the shared shape", () => {
  const turn = parseClaudeEvents(CAPTURE)
  assert.deepEqual(turn.messages, ["Running the check.", "Done: the tool ran."])
  assert.equal(turn.tools.length, 1)
  assert.equal(turn.tools[0]!.id, "toolu_stub_1")
  assert.equal(turn.tools[0]!.kind, "Bash")
  assert.equal(turn.tools[0]!.detail, "echo stub-tool-ran", "the row names the command, not the tool")
  assert.equal(turn.tools[0]!.status, "completed", "the tool_result completed the row the tool_use opened")
  assert.equal(turn.tools[0]!.exitCode, 0)
  assert.deepEqual(turn.errors, [])
  assert.deepEqual(turn.notices, [])
  assert.match(describeTurn(turn), /1 tool/)

  // The trap: Claude's `input_tokens` does NOT include the cached tokens, so a parser that copied
  // Codex's subtraction would report 320 here instead of 360 — undercounting, where Codex's own
  // field would have double-counted without the subtraction.
  assert.deepEqual(turn.usage, { input: 360, cached: 40, output: 32, reasoning: 0 })
})

test("thinking tokens are lifted out of output rather than counted twice", () => {
  // `Turn` prices output and reasoning separately, and Claude's `output_tokens` includes thinking.
  // Adding them as they arrive would charge the thinking twice. The captured turn had zero
  // thinking, which proves nothing about the overlap; this pins the mapping so one real measuring
  // turn can flip it in a single place.
  const withThinking = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    permission_denials: [],
    usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 30, output_tokens_details: { thinking_tokens: 12 } },
  })
  const turn = parseClaudeEvents(withThinking)
  assert.deepEqual(turn.usage, { input: 10, cached: 0, output: 18, reasoning: 12 })
})

test("a permission denial is surfaced: an agent that was blocked has to say so", () => {
  // This is the field that lets moat keep invariant 3 without `--dangerously-skip-permissions`
  // (which Claude Code refuses as root). The allowlist prevents the prompt; `permission_denials`
  // is the reading that says whether the allowlist was complete enough.
  const withDenial = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_1" }],
    usage: { input_tokens: 5, output_tokens: 1 },
  })
  const turn = parseClaudeEvents(withDenial)
  assert.equal(turn.notices.length, 1)
  assert.match(turn.notices[0]!, /permission denied: Bash/)
})

test("an auth failure is an error, not a notice", () => {
  const authFail = [
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Not logged in · Please run /login" }],
        error: "authentication_failed",
        is_api_error_message: true,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", result: "Not logged in · Please run /login" },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n")
  const turn = parseClaudeEvents(authFail)
  const joined = turn.errors.join(" | ")
  assert.match(joined, /authentication_failed/)
  assert.match(joined, /api_error/)
  assert.deepEqual(turn.notices, [], "a broken turn is not a notice")
})

test("non-JSON lines and unknown events are ignored, never guessed at", () => {
  // The launcher merges stderr into the same capture, so a non-JSON line is expected rather than
  // exceptional, and a newer CLI must not make the parser invent rows.
  const noisy = [
    "not json at all",
    "",
    '{"type":"something_new","payload":1}',
    '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"…"}],"usage":{"input_tokens":5,"output_tokens":2}}}',
  ].join("\n")
  const turn = parseClaudeEvents(noisy)
  assert.deepEqual(turn.messages, [], "thinking is not prose")
  assert.equal(turn.tools.length, 0)
  assert.equal(turn.errors.length, 0)
  // No `result` event, so the per-request usage is the fallback rather than nothing.
  assert.deepEqual(turn.usage, { input: 5, cached: 0, output: 2, reasoning: 0 })
})
