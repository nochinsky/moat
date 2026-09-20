# The opencode runtime: what it was, and where its claims went

moat used to ship two runtimes: **opencode** — a server inside the box, driven over HTTP —
and **Codex**, a CLI. Two runtimes meant two configs, two session models, two acceptance
lists and a bigger image, and the server shape was the source of most of moat's incidental
complexity. opencode is deleted. This file is the record: what it was, why it went, and where
each of its claims lives now.

## What it was

* `opencode serve --port N --hostname 127.0.0.1` ran inside the box as the agent's loop and
  tool dispatcher; the host was a client of that server (`cmd/client.ts`), and `moat attach`
  and `moat` opened moat's own interactive session (`cmd/repl.ts`, `cmd/display.ts`) against
  the server's event stream.
* Policy lived in a rendered `opencode.json` (`bundle/render.ts`) plus an in-box ESM plugin
  (`bundle/plugin/moat-bundle.mjs`) that refused tools outside a curated set, confined
  `write`/`edit`/`apply_patch` to the workspace, and recorded an audit log at
  `/var/log/moat/tools.jsonl`.
* `moat tools` printed the curated set, the registry, and the measured gap between them;
  `moat env` printed the server's URL, user and password.
* The image carried `opencode-ai@1.18.31` (musl). Both binaries were pinned and
  digest-verified in `lib/pins.ts`.

## Why it went

* **The box, not the server, is the product.** Everything moat actually guarantees —
  namespaces, copy-in and copy-out, the credential rule, egress — is independent of which
  program runs the agent loop.
* **The curation was never complete.** opencode 1.18.31 had no supported way to remove a
  built-in tool from the model-facing list; the plugin could refuse a call but not hide it,
  so the "curated set" requirement was met in behaviour and not in advertisement. Under Codex
  the same requirement is simply not attempted, and the docs say so.
* **The interactive surface was a reimplementation.** moat owned the transcript, the input
  line, `/model`, `/think`, `/undo`, `/compact` and the rendering, all of it code that had to
  track a fast-moving upstream.
* **Cost.** A turn on Codex uses more tokens and more money than the same turn did on
  opencode, because Codex carries a larger harness prompt. The measurement is in
  `docs/RUNTIME-COST.md`; the trade was made deliberately.

## Where things moved

| opencode-era thing | now |
| --- | --- |
| `opencode serve`, `cmd/client.ts`, the HTTP session | gone; `codex exec --json` for a turn, Codex's own TUI for a session |
| `cmd/repl.ts`, `cmd/display.ts`, `moat attach`, `/diff`, `/verify`, `/model`, `/think` | gone; the TUI is Codex's, on the terminal moat inherited |
| `bundle/render.ts`, `opencode.json`, `permission: {"*": "allow"}` | `bundle/codex.ts`: `approval_policy = "never"`, `sandbox_mode = "danger-full-access"` |
| `bundle/plugin/moat-bundle.mjs` (tool curation, write confinement, audit log) | gone; the tool list is the CLI's, and the box is the bound |
| `--tools`, `--effort`, `moat tools`, `moat env`, `--port`, `--runtime` | gone; a flag that cannot do anything is refused, not accepted |
| the literal-key check in `bundle/install.ts` | `installCodexFiles` in `bundle/codex.ts`, same refusal |
| `test/e2e.sh`, `test/mock-model.mjs`, the chat-completions fixtures | `test/e2e-codex.sh`, `test/mock-responses.mjs` (Responses wire) |
| `test/repl-*.py`, `test/wire-effort.py`, `test/inspect-tool-schemas.mts` | gone; `test/codex-tui.py` is the pty check |
| `/var/log/moat/tools.jsonl`, `exposure.json`, `permissions.jsonl` | gone; the `codex exec --json` stream is the record of what a turn ran |

The unit tests that pinned the plugin, the bundle renderer, the effort variants and the
session display were deleted with their subjects. The ones that pin the runtime
(`test/unit/codex-runtime.test.ts`, `runtime-image.test.ts`, `runtime-install.test.ts`,
`interactive-term.test.ts`) stayed.

## What this cost, and what it did not

The image no longer carries a Node runtime for the agent, the box no longer listens on a
port, and no host port forward exists in either direction. The agent's tool list is no longer
moat's to choose. What did **not** change: the mount table and the six device binds, the
credential rule (environment only, never in the image, scanned on the way out), copy-in by
`git clone --no-hardlinks`, copy-out through `moat fetch` and `moat apply`, the egress
policy, and `moat verify` / `moat take`.

## Where the old claims went in the docs

* `docs/SPEC.md` — §1.2 (what the box does not protect), §2.2b (one runtime, the config
  moat renders), §2.3 (no server, nothing to wait for), §2.4 (the command table), §6 (what
  moat does *not* control), §6b.5 (the interactive surface), §6b.7 (questions), §7.3 (no
  forward), §9 and §10.
* `docs/VERIFICATION.md` — the criteria that existed only because of the server were
  deleted; the runtime sections quote `test/evidence/codex-*.txt` and `extras.txt`; the
  closing "Not verified" table names the limits that replaced them.
* `README.md` and `AGENTS.md` — the command list, the invariants and the traps.

This file replaces the migration checklist that used to live here. The checklist is done.
