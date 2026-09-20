# Spike: Codex CLI as moat's runtime

**Question.** moat drives opencode 1.18.31 over its HTTP API and owns a hand-written REPL as
the interactive surface. Is a different runtime — Codex CLI, which is what the "feels like a
real harness" comparison is usually about — a better fit, and what would adopting it cost?

**Answer.** Codex runs unmodified inside moat's Alpine sandbox, drives DeepSeek over the
Responses API, edits files, and reports a structured event stream with token usage. No fork,
no glibc shim, no Node in the image. The work is an adapter plus a config renderer, not a
rewrite. What it changes is the *interactive client* and two invariant wordings; what it does
not change is the sandbox, the credential broker, copy-out or verification.

## What was measured

On this host, with a real DeepSeek credential in the box.

### 1. The binary runs on Alpine as shipped

The npm platform tarball `@openai/codex@0.155.1-linux-x64` (142,140,011 bytes,
sha256 `f110cccdd50b0be8130b84f45b3144ea775c233f1c8bd8226da6ee719d63d206`) ships
`vendor/x86_64-unknown-linux-musl/bin/codex`: a static musl build, 269,273,536 bytes.

```
$ codex --version
codex-cli 0.155.1
```

`apk add gcompat` was never needed. (It also could not work from inside a filtered box:
`dl-cdn.alpinelinux.org` is not in the allowlist, and apk failed with `2 errors` there.)

### 2. A live task works, end to end

Config rendered into the box's `~/.codex/config.toml`:

```toml
model = "deepseek-v4-pro"
model_provider = "deepseek-moat"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.deepseek-moat]
name = "DeepSeek"
base_url = "https://api.deepseek.com"
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"
```

`codex exec --json --skip-git-repo-check "Create a file named CODEX-SPIKE.txt ..."` in
`/work`, `--egress isolated`, minted credential present:

```
exit=0 wall=5s
{"type":"turn.started"}
{"type":"item.started","item":{"type":"command_execution","command":"/bin/sh -c \"printf 'hello from codex' > CODEX-SPIKE.txt\"","status":"in_progress"}}
{"type":"item.completed","item":{"type":"command_execution","command":"/bin/sh -c \"printf 'hello from codex' > CODEX-SPIKE.txt\"","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"type":"agent_message","text":"Created `/work/CODEX-SPIKE.txt` with contents exactly `hello from codex`."}}
{"type":"turn.completed","usage":{"input_tokens":18118,"cached_input_tokens":9088,"cache_write_input_tokens":0,"output_tokens":238,"reasoning_output_tokens":0}}
```

The file existed with exactly those bytes. The event stream is JSONL with `item.started` /
`item.completed` / `turn.completed`, and `turn.completed.usage` carries the same token fields
(`input` = cache miss, `cached_input_tokens` = cache hit, `output_tokens`,
`reasoning_output_tokens`) that `lib/pricing.ts` already prices.

### 3. Provider variants and egress modes

All three runs below were under moat's **default `filtered` egress** (own network namespace,
default-deny allowlist, provider host resolved at boot); only the first live run used
`--egress isolated`. Reaching `api.deepseek.com` needed no new allowlist entry — the provider
host is already in it.

| config | exit | metadata warning | `turn.completed.usage` |
| --- | --- | --- | --- |
| custom `[model_providers.deepseek-moat]` | 0 | once, on the first run | 8915 in (640 cached), 2 out |
| built-in `model_provider = "deepseek"` | 1 | — | `Error: Model provider 'deepseek' not found` |
| custom + `model_context_window` / `model_max_output_tokens` | 0 | none | 8915 in (8832 cached), 2 out |

Three things worth keeping:

* The docs' "built-in provider support" list did not match 0.155.1: DeepSeek is named there,
  but the id is not recognised, and a `[model_providers.*]` block is what works.
* `Model metadata for deepseek-v4-pro not found. Defaulting to fallback metadata; this can
  degrade performance and cause issues.` is a **cold cache**, not a config error: it appeared
  on the first run in a fresh `~/.codex` and not afterwards. Render
  `model_context_window`/`model_max_output_tokens` anyway so the first run is not a guess.
* Both successful runs printed `Reading additional input from stdin...`; an adapter should
  close stdin rather than leave it attached.

### 4. The CLI surface (from `codex --help`)

`exec` (non-interactive), `review`, `login`/`logout`, `mcp`, `plugin`, `app-server`
(experimental), `remote-control` (experimental), `completion`, `update`, `doctor`, `sandbox`,
`debug`, `apply`, `resume`, `queue`, `archive`, `delete`, `migrate-rollouts`, `agents`.
`codex` with no subcommand is the TUI. `app-server` is the documented embedding surface
(OpenAI's "Unlocking the Codex harness" post describes it; the page was behind Cloudflare and
could not be read from here).

## What was built from this spike

The spike turned into a working first integration in the same session:

* `lib/pins.ts` pins `CODEX_VERSION` and the platform tarball's sha256, per triple; a triple
  without a digest is refused rather than downloaded unverified.
* `sandbox/rootfs.ts` installs the binary into every image, and `imageCachePath` includes
  the Codex version, so a cached image cannot silently lack it. Measured cold start: 62s
  (from 13s), image +269 MB.
* `bundle/codex.ts` renders `~/.codex/config.toml` on every boot through the rootfs guard
  (approvals never, Codex's sandbox off, `wire_api = "responses"`, a `[model_providers.*]`
  block, and the context window from the catalog so the first run is not a guess), and parses
  `codex exec --json` into tool rows, messages and the usage the pricing table already knows.
* `--runtime codex` on `up`/`run`: the box is a keepalive, tasks run through
  `runCodexTask`, and `moat` opens Codex's TUI over a pty in its own ephemeral boot.
  `moat status` reports the runtime instead of an endpoint that does not exist.
* `test/unit/codex-runtime.test.ts` (5 tests) pins the config renderer and the event parser
  against a real captured stream. `moat up --runtime codex` then `moat run --runtime codex
  "..."` created a file in `/work` with the exact contents, reported
  `26129 tokens  $0.0027 off-peak  1 tool` and exited 0.

Not done yet: an e2e section in `test/e2e-extras.sh`; suppressing Codex's
"Model metadata … not found" advisory, which currently counts as one error in the footer;
the TUI (untested here, no pty); and SPEC's runtime paragraph.

## What an adapter would cost

* **Provisioning.** Pin the Codex version and per-arch tarball digest in `lib/pins.ts`, verify
  and unpack like the opencode payload. The binary is 269 MB unpacked against opencode's
  ~110 MB, so the image roughly doubles. It must be part of the image: a spike run that
  unpacked it into a live rootfs lost it on the next `moat destroy` + `moat up`.
* **Config.** moat renders `~/.codex/config.toml` from the same inputs as the opencode bundle
  (model, provider, base URL, approvals/sandbox) and keeps rendering `/work/AGENTS.md`, which
  Codex reads natively.
* **Credential.** `DEEPSEEK_API_KEY` in the sandbox process environment — moat already injects
  it for the native provider when it launches the runtime. (This spike used a 0600 file in the
  rootfs only because `moat exec`'s ephemeral boot does not carry the credential env.)
* **Interactive surface.** `moat` attaches Codex's TUI over a pty inside the box
  (`runInteractive`, the same path `moat shell` uses).
* **Host-driven surface.** `moat run` parses `codex exec --json`; usage feeds the footer.
* **Invariants that need rewording, not weakening:** #6 ("the host is an HTTP client of the
  server in the box; nothing is proxied") becomes "the host is a terminal or a JSONL reader
  for an in-box process". The point — loop, tools and filesystem inside the box — survives.
* **The plugin guard has no Codex analogue.** opencode's `permission: {"*": "allow"}` is
  asserted in-box by moat's plugin. With Codex the equivalent is `approval_policy = "never"`
  and `sandbox_mode = "danger-full-access"`, and moat must *verify the rendered config*
  (hash or a Codex-side check) rather than trust a file the agent can edit.
* **Tool curation** (requirement 4) was already not achievable against opencode; Codex has its
  own tool set and MCP surface, and the same honesty applies to whatever it advertises.
* **Suites.** The sandbox, copy-out, credential and egress suites are runtime-agnostic and
  keep passing. The runtime paths (`moat run`, attach, footer, checks) need their own section,
  and the live suite should be re-run against Codex.

## Not verified

* the interactive TUI inside the chroot (this harness has no pty);
* long autonomous runs and compaction, and whether the fallback model metadata is right for
  `deepseek-v4-pro`;
* `app-server` / `remote-control` as an integration surface;
* Codex's session store and `resume` semantics inside the box;
* dollars: the spike reported tokens, not cost.
