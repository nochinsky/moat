# Removing opencode: what it costs, and what has to happen first

State: Codex is the default runtime, opencode is selectable with `--runtime opencode`. Two
runtimes is debt — two configs, two session models, two suites, a bigger image — and this is
the checklist for ending it without breaking the product on the way.

## What is already true

* Codex is pinned and digest-verified, installed per image, configured by moat on every boot,
  and covered keylessly (extras section AK drives a scripted turn through
  `test/mock-responses.mjs`, whose event shapes were captured from a real DeepSeek stream, then
  fetches the commit it produced) and live (live suite section 7).
* The sandbox, credential, copy-out and egress layers are runtime-agnostic; their suites do not
  care which runtime produced the work, and all three batteries are green.

## What deleting opencode removes — say it out loud

1. `cmd/client.ts` (~650 lines) and `cmd/repl.ts` (~1220 lines): the HTTP session client and the
   interactive session. Codex's TUI replaces the REPL, and `moat attach`, `/diff`, `/verify`,
   `/model`, `/think`, `/sessions`, `/share` and the pty suites go with it.
2. `sandbox/serve.ts`, `bundle/render.ts` and the in-box plugin: the opencode server entry, the
   rendered opencode config, and the guard that asserts `permission: {"*": "allow"}`. Invariant 3
   is written as an opencode *mechanism*; the equivalent guarantee under Codex is the
   moat-rendered `approval_policy = "never"` + `sandbox_mode = "danger-full-access"`, which
   `test/unit/codex-runtime.test.ts` and extras AJ already hold.
3. `moat tools` and `moat env` (both already refuse on a codex environment): they become
   codex-facing commands or they are deleted, not quietly kept as stubs.
4. `--effort`/reasoning variants: Codex has `model_reasoning_effort`, but it sends the setting
   only for models it has metadata for, and it has none for DeepSeek's (measured: the value
   never reached the wire). The flag is therefore *refused* under the codex runtime rather
   than ignored, and `bundle/codex.ts` renders a stored effort only for the levels Codex
   accepts. Making it work needs model metadata Codex does not have; until then the honest
   state is a refusal.
5. The acceptance suite's **driver**: `test/e2e.sh` drives opencode through `moat attach` and the
   chat-completions stub. Its criteria are the product's acceptance list, so they get *ported* to
   Codex plus the Responses stub, not deleted.
6. `test/mock-model.mjs`, the opencode pins, `ensureOpencodeBinary`, and the chat-completions
   scripts, once nothing speaks chat completions.

## The order that keeps every suite green

1. Port the acceptance checks in `test/e2e.sh` to Codex + the Responses stub one at a time,
   keeping the opencode version until the Codex one passes. Interactive checks (attach
   streaming, sessions) become TUI checks or are dropped with the REPL.
2. Port or drop the extras sections that are opencode-specific (the pty REPL suites, tools,
   plugin guard, effort).
3. Then delete, in this order: the plural runtime plumbing (`--runtime`, `RUNTIMES`,
   `RUNTIME_BINARY`); `cmd/repl.ts`, `cmd/client.ts`, `sandbox/serve.ts`, `bundle/render.ts` and
   the plugin; the opencode install and pins; `test/mock-model.mjs`; the `--runtime opencode`
   pins the suites currently carry.
4. Update the docs last: SPEC §2.2b and §6b.5, the AGENTS opencode traps, and VERIFICATION —
   deleting the sections whose subject no longer exists (session display, tool curation, the
   plugin guard, effort variants) and updating the closing table.

## What must not be lost

* `moat fetch` / `moat apply` / `moat verify` / `moat take` and their tests. The loop is the
  product.
* The credential rules (env only, never in the image, scanned on the way out) and the egress
  policy.
* The measured facts: `docs/RUNTIME-COST.md` says what each runtime costs, and it stays true
  even after one of them is gone.