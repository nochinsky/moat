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

## Claude Code: the policy, measured before any adapter was written

Phase 2 picked Claude Code as the second runtime. The **packaging** checks out and is pinned
(`lib/pins.ts`, §"A second runtime's artefact"): the npm package is a platform package with
`dependencies: {}` carrying a musl build, and it runs on the Alpine image with no Node —
`./package/claude --version` inside a real moat sandbox printed `2.1.278 (Claude Code)`.

### `bypassPermissions` is out, and it does not matter

The obvious mode is the root-refused one:

```
$ claude -p --permission-mode bypassPermissions "hi"        # uid=0, inside the moat box
--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
```

`bypassPermissions` is the only mode that means "never ask **and** never block", and Claude Code
refuses it when the process is root — which moat's agent is by design. Running the agent as a
non-root user is not an escape either, measured in the same box:

```
$ adduser -D -h /home/moat moatuser && chown -R moatuser /home/moat
chown: changing ownership of '/home/moat': Invalid argument
$ su moatuser -s /bin/sh -c 'cd /work && claude …'
su: can't set groups: Operation not permitted
```

One uid is mapped in the namespace; there is no second identity to become.

**But `bypassPermissions` is not the only way to never ask.** `--allowedTools` is an *additive
auto-approval* list — a listed tool never prompts — and in `--print` mode anything that would
prompt is auto-**denied** rather than made to hang, so a non-interactive turn cannot block on a
question there is no channel to answer. Measured as root, with the body shape this implies (the
prompt goes on **stdin**: `--allowedTools` is variadic and eats a trailing positional argument):

```
$ printf 'say hi' | claude -p --output-format stream-json --verbose \
      --permission-mode acceptEdits --allowedTools Bash Edit Write Read Glob Grep
{"type":"system","subtype":"init","cwd":"/work","permissionMode":"acceptEdits","tools":[…25 tools…], "apiKeySource":"none"}
{"type":"assistant","message":{…,"error":"authentication_failed","is_api_error_message":true}}
{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","permission_denials":[],…}
```

An auth failure, not a flag error: the mode and the allowlist are accepted as root. So invariant 3
is reachable without a multi-uid namespace, by *allowing the tools the agent needs* rather than by
turning permission checks off.

### Three things the capture gave for free

1. **`permission_denials`** is a field on the `result` event. "Never blocked" stops being a promise
   and becomes a **reading**: the adapter can surface any tool call that was denied, which is what
   would catch an agent that is quietly failing because the allowlist is incomplete.
2. **`--bare` curates the tool surface.** Without it the runtime advertises 25 tools (`Task`, the
   `Cron*` family, `DesignSync`, `EnterWorktree`, `WebFetch`, `WebSearch`, `Workflow`, …). With it:
   `"tools":["Bash","Edit","Read"]`. That is moat **choosing the tool set** — requirement 4, which
   §"Requirement 4" in `docs/VERIFICATION.md` records as *not met* under Codex because Codex offers
   no supported way to prune the list. Under Claude Code it is a flag.
3. **The usage fields are confirmed real**, not read from a summary: `input_tokens`,
   `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`,
   `output_tokens_details.thinking_tokens`, and a top-level `total_cost_usd`. The trap from §"The
   trap worth knowing" applies: `cache_read_input_tokens` is a **separate** field here, so a parser
   that subtracts it from `input_tokens` the way Codex's does would undercount, and whether
   `output_tokens` includes `thinking_tokens` still has to be measured against a real turn (the
   capture has thinking at 0, which proves nothing).

### The tool turn, measured — this is the answer

The open question was whether an allowlisted call actually runs **un-denied**. Measured with a
keyless stub of the Messages API on the host's loopback, `--egress open`, and a real box:

```
$ printf 'run the check' | ANTHROPIC_BASE_URL=http://127.0.0.1:5611 ANTHROPIC_API_KEY=stub-key \
      claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Bash
system/init
assistant   content=['text']
assistant   content=['tool_use']          <- Bash: echo stub-tool-ran
user        content=['tool_result']       <- "stub-tool-ran": the command really ran
assistant   content=['text']
result/success  is_error=False  permission_denials=[]  cost=0.0026825
```

`permission_denials=[]` with `is_error=false` while a `Bash` command executed: **"never asks" holds,
and "never blocked" is a reading** rather than a promise. The captured shapes the parser is written
against, with the fields it reads:

```
system/init   { cwd, model, permissionMode, tools:[…], apiKeySource }
assistant     { message: { content: [ {type:"text",text} | {type:"tool_use",id,name,input} ],
                           usage: { input_tokens, output_tokens,
                                    cache_read_input_tokens, cache_creation_input_tokens },
                           error?, is_api_error_message? } }
user          { message: { content: [ {type:"tool_result", tool_use_id, content, is_error} ] } }
result        { subtype, is_error, num_turns, total_cost_usd, permission_denials:[],
                result, stop_reason, usage: { …, output_tokens_details:{thinking_tokens} } }
```

The numbers also settle the trap from the section above: the `result` usage was
`input_tokens: 360`, `cache_read_input_tokens: 40`, `cache_creation_input_tokens: 10`,
`output_tokens: 32` — the sum of the turn's two requests, with the cache reported **separately**. So
`input_tokens` *is* the miss count for Claude; a parser that subtracted the cache the way Codex's
must would have reported 320 and undercounted.

Still unmeasured: whether `output_tokens` **includes** `thinking_tokens` (the turn had thinking at
0, which proves nothing), and what `dontAsk` does to a call that would otherwise prompt. Both are
pinned in one place — `bundle/claude.ts` and `test/unit/claude-runtime.test.ts` — so the first real
turn with a thought can flip them without touching anything else.

The decision this leaves is smaller than it looked: **keep invariant 3, do not touch the user
namespace, and render the tool allowlist as policy** — with the caveat that moat would now be
*choosing* the agent's tools, which is a promise it does not currently make for Codex.
