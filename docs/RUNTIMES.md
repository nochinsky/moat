# Adding another agent runtime

moat drives one agent today: the pinned Codex CLI. This file records what it would take to drive
a second one, and why the answer is *not* to adopt a protocol for it. It exists because "should we
support more agents, and do we need ACP to do it?" is a question that will come back, and the
measurements below are cheaper to re-read than to redo.

`docs/SEAM.md` is the interface this builds on. Read that first if you have not.

## What moat actually needs from a runtime

A command that runs in the box, writes newline-delimited JSON to stdout, and exits. Then a parser
that turns that stream into `CodexTurn` — tool rows, messages, usage, errors, notices.

That is the whole contract. Three properties make it work, and none of them are Codex-specific:

1. **Batch, not interactive.** moat hands the box a script and reads the stream afterwards.
2. **The agent owns the box.** The agent runs as root inside its own rootfs; moat does not
   intercept its tool calls, and does not need to.
3. **No port, no server.** The agent is a subprocess of a script, and the client is the host
   terminal or a log reader.

## The ecosystem already speaks this

Measured, not read from a summary. On this machine, `claude -p --output-format stream-json
--verbose "Reply with exactly: pong"` produced JSONL of this shape:

```json
{"type":"system","subtype":"init","model":"…","tools":[…],"mcp_servers":[…],"permissionMode":"default"}
{"type":"assistant","message":{"content":[{"type":"thinking",…}],"usage":{"input_tokens":19688,…}}}
{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}],"usage":{…}}}
{"type":"result","subtype":"success","result":"pong","stop_reason":"end_turn","num_turns":1,
 "total_cost_usd":0.098515,"usage":{"input_tokens":19688,"output_tokens":3,
 "cache_read_input_tokens":0,"output_tokens_details":{"thinking_tokens":0}},
 "modelUsage":{"…":{"contextWindow":1000000,"maxOutputTokens":32000,…}}}
```

Gemini CLI documents the same arrangement under `--output-format stream-json`
([headless mode reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md)):
`init`, `message`, `tool_use`, `tool_result`, `error`, `result`, with per-model token usage in the
final event. Its `--output-format json` returns one object with `response` and `stats`.

So the convention is: **an init event, incremental events, and a final result carrying usage.**
That is close enough to what `parseCodexEvents` already does that a second parser is a day's work,
not an architecture.

## Why not ACP

The [Agent Client Protocol](https://agentclientprotocol.com/) is real and healthy — the
[registry launched in January](https://zed.dev/blog/acp-registry) with Claude Code, Codex, Copilot
CLI, Gemini CLI and others, built into Zed and JetBrains. It is not a dead end. It is also aimed
at a problem moat does not have.

**ACP standardises how an *editor* drives agents.** Its value is that a client implements the
protocol once and gets every agent, and that an agent implements it once and appears in every
client. Zed and JetBrains are the beneficiaries, and their motive is distribution inside an IDE.

moat is not a client in that sense. It runs one agent per environment, headless, and its
interesting work happens *after* the turn: the baseline, the three-way classification, the
per-hunk review. None of that touches the protocol.

What ACP would cover here is one of five pieces:

| what a runtime needs | does ACP cover it? |
| --- | --- |
| a way to drive a turn and read events | **yes** — this is what the protocol is |
| rendering the agent's config for the box | no — every agent has its own file format |
| injecting the system prompt / brief | no — `AGENTS.md` vs `CLAUDE.md` vs `GEMINI.md`, different scopes |
| naming the credential variable | no — and moat's invariant 8 forbids guessing |
| the agent's approval and sandbox policy | no — and moat overrides it deliberately |

Four of the five are per-agent work regardless, and they are the parts that produce security bugs
when they are wrong. Adopting ACP would not remove them; it would add a protocol layer, a
third-party adapter to pin and trust, and — measured in the Phase 4 spike — **a Node runtime in
every box**, which the default image deliberately does not have.

The Phase 4 spike also found the adapter overrides `approval_policy` per turn from its own mode
table, so moat's rendered `approval_policy = "never"` would stop being what decides whether the box
asks. That is a security-relevant behaviour change bought for a parsing convenience.

**Decision: do not adopt ACP.** Revisit if moat ever needs to *be* an ACP client — for instance if
the box should serve a session to an editor — which is not on any roadmap.

## What adding a runtime would actually involve

If a second agent is wanted, this is the list. It is bounded, and it is the same list for any
agent, protocol or not.

1. **A body script**, beside `codexExecBody`, that runs the agent's headless JSON mode.
2. **A parser**, beside `parseCodexEvents`, producing `CodexTurn`. Unknown events are ignored, and
   a notice is not an error — both already true of the Codex parser and both worth keeping.
3. **A config renderer** for that agent's own file, written through `lib/rootfs-fs.ts` on every
   boot, carrying that agent's version of moat's policy: no approval prompts, no second sandbox.
4. **A brief**, rendered from `InstructionsInput` so it describes the boot that was actually made.
   Every claim in it needs both branches, which is what `test/unit/instructions.test.ts` enforces.
5. **An auth story** that names the provider's variable explicitly, never inferred, and a pin in
   `lib/pins.ts` for the binary plus a digest check before it is unpacked.
6. **A pricing path.** This is the trap; see below.

## The trap worth knowing before you write an adapter

**Token accounting differs between agents, and getting it wrong misprices silently.**

Codex's Responses `input_tokens` **includes** the cached tokens, so moat subtracts
`cached_input_tokens` before pricing the miss rate. Charging the raw field overstated a
mostly-cached turn by about ten times — a real bug, measured, fixed, and pinned by
`test/unit/codex-runtime.test.ts`.

Claude Code reports `cache_read_input_tokens` as a **separate** field, and its final `result` event
carries `total_cost_usd` alongside per-model `usage` with `contextWindow` and `maxOutputTokens`.
Those are not the same semantics, and a parser that assumed Codex's shape would double-count.

Before trusting a new adapter's footer, run one turn through the recording stub, read the usage
fields that actually arrived, and compare the arithmetic against `lib/pricing.ts` by hand. A cost
figure that looks plausible is the failure mode.
