# How moat got here

This page exists so the old runtime documents can stay deleted. It records what was
tried, what was measured, and why the current shape won. Nothing here is a plan.

## The runtime before this one

moat started with opencode as a library: the box ran `opencode serve`, and the host was an
HTTP client of it, with a port forwarded through slirp so the two could talk. That worked,
and it cost more than it looked: a server inside the box meant a host-facing port, basic
auth with a password written next to the state file, a plugin that had to re-check the
permission policy inside the box on every load, and a session client moat maintained itself.

It was removed in one pass. What replaced it is one pinned binary: Codex CLI. The box runs a
keepalive, every task runs `codex exec --json` in its own ephemeral boot of the same rootfs,
and a session is Codex's own TUI on a pty moat hands over. With the server went the port
forward, the password, the plugin, the session client, and slirp's API socket.

## The DeepSeek configuration

Codex does not ship a working DeepSeek provider, and moat does not guess at one. DeepSeek
publishes a Codex setup, and moat renders it into the box on every boot:

* `[model_providers.deepseek]` with `wire_api = "responses"`, which DeepSeek's API serves
  natively.
* `preferred_auth_method = "apikey"` and `forced_login_method = "api"`, so Codex never
  looks for a ChatGPT account.
* `model_catalog_json` pointing at `bundle/deepseek-models.json`: their metadata for
  `deepseek-flash` and `deepseek-v4-pro` (context window, reasoning levels, tool shapes).
  Without it, Codex prints "Model metadata for ... not found. Defaulting to fallback
  metadata" and drops settings it cannot verify.
* `web_search = "disabled"`. DeepSeek's Responses API accepts a `web_search` tool and
  ignores it: a live call returns HTTP 200 with no `web_search_call` item and the model
  answering that it cannot search. Advertising it would only invite calls that cannot work.

The key stays an environment variable. DeepSeek's own snippet writes it into the config
file; moat does not, and `installCodexFiles` refuses to write a config that looks like it
carries one.

**The prompt pin.** Codex's catalog schema requires `base_instructions` or
`model_messages.instructions_template`; a catalog with neither makes the binary exit 1.
DeepSeek's copy of that field is *their* text, and with the catalog installed Codex sends it
as the request's `instructions`. moat therefore pins the pinned binary's **own** built-in
prompt there, by sha256, so adopting the catalog changes metadata and never the prompt. A
Codex version bump can move that prompt, and the pin has to move with it.

`--effort` renders `model_reasoning_effort`. That config line is what Codex honours:
measured with the catalog present, `high` and `low` differ on the wire, and flipping the
catalog's own `default_reasoning_level` changes nothing. The levels are DeepSeek's (`low`,
`high`, `max`), read from the catalog rather than hardcoded.

## What was rejected

* **Patching the Codex binary.** It would break the digest pin that makes the runtime
  reviewable. Everything above is configuration; a fork stays the answer to a measured wall,
  and no wall has been measured.
* **A local web search tool.** DeepSeek has search on their website, not in the API. A tool
  we wrote ourselves would be a new outbound dependency and a new exfiltration channel, so
  it is a product decision, not a config flag, and it is not made.

## Cost, measured once

On a trivial task through a recording proxy, Codex used about 17,700 tokens against
opencode's 9,400, mostly because its prompt and output are larger. Roughly 2.8x the tokens
for the same work. Worth knowing before calling the swap free.

## Where the claims live now

* `docs/SPEC.md` states the contract, including what the sandbox does not protect.
* `docs/VERIFICATION.md` holds the criteria, the captures, and the table of what is not
  verified.
* `AGENTS.md` carries the traps, including the catalog and prompt-pin notes above.
