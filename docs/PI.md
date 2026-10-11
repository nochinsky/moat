# Customize the harness, keep the box

Pi is moat's only agent harness. **Pi controls how the agent works; moat controls where it works
and what is copied back.** There is no runtime selector, and neither Codex nor Claude Code is
installed in new images.

## Everyday use

```sh
moat                              # Pi's TUI, inside the sandbox
moat run --no-follow "fix tests"  # one headless invocation, with a host-side report
moat run --max-tokens 20000 "fix tests"  # budgeted invocations are headless
moat verify
moat take
moat apply
```

Pi's `/model`, `/thinking`, `/resume`, `/tree`, `/reload`, skill commands and extension commands
are Pi's own UI. Session files live inside the persistent rootfs. Leaving the TUI leaves the
keepalive box running; `moat down` stops it without deleting sessions or work.

## Project-local configuration

Commit customization with the project so it travels with moat's copy-in:

```text
.pi/settings.json
.pi/extensions/*.ts
.pi/skills/<name>/SKILL.md
.pi/prompts/*.md
.pi/themes/*.json
.pi/mcp.json
```

For example, enable Pi's search tools alongside the default read/bash/edit/write set:

```json
{ "defaultTools": ["+grep", "+find", "+ls"] }
```

A workflow command can live in `.pi/extensions/project-checks.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function (pi: ExtensionAPI) {
  pi.registerCommand("project-checks", {
    description: "Run this project's tests inside the sandbox",
    handler: async (_args, ctx) => {
      const result = await pi.exec("npm", ["test"])
      ctx.ui.notify(result.stdout || result.stderr, result.code === 0 ? "info" : "error")
    },
  })
}
```

Use Pi's `registerTool` for tools the model calls, hooks for agent behavior, and skills/prompts for
reusable instructions. Pi's own documentation and examples ship inside the sandbox under
`/opt/moat/pi/node_modules/@earendil-works/pi-coding-agent/`. There is no second moat extension API.

The copied project's configuration is trusted with `--approve`. **Extensions are arbitrary
executable code**: they run inside the box with access to its project, environment and network,
never on the host. A permission-gate extension can reintroduce prompts or denials; unattended
workflows must not require a UI response. Moat does not promise arbitrary extensions are compatible.

### Packages

Automatic Pi catalog/version traffic is disabled with offline mode, telemetry is disabled, and
cache warming is off. Missing npm/git Pi packages may need an explicit installation inside the
box rather than being fetched on startup:

```sh
moat exec -- pi install --local npm:your-pi-package
```

The package manager and executable code stay inside the sandbox. Installed work/resources survive
`down`/`up`; a subsequent explicit sync follows normal copy-in rules. Prefer project declarations
in `.pi/settings.json`: moat regenerates its global settings on every boot. Additional package,
MCP or provider destinations may need `--egress-allow`; the proxy also supports explicit ports.
Host-local executable/config paths in `.pi` will not work inside the box: use project-relative
paths or install the dependencies there.

## Providers and credentials

DeepSeek is still the default, not whatever provider happens to have a key in your host environment.
Other compatible endpoints are explicit:

```sh
moat provider add local --base-url http://127.0.0.1:11434/v1 --model your-model --wire-api chat
moat run --provider local --no-credential "explain this code"

moat provider add team --base-url https://gateway.example/v1 --env-var TEAM_API_KEY --model team-model
moat run --provider team --credential-env TEAM_API_KEY "fix tests"
```

`responses` and `chat` select OpenAI Responses and Chat Completions respectively. Native Anthropic,
Google or other protocols are not implied by `moat provider add`; an extension/provider integration
needs its own compatibility testing. Endpoint, complete model id, protocol and effort are remembered
across boots. Unknown limits are left to Pi's fallback rather than invented as provider facts.

Moat never imports host `~/.pi`, `auth.json`, OAuth tokens, extensions, MCP configuration or dotfiles.
It writes only an environment-variable reference into the sandbox model configuration. Keyless
compatible endpoints get a dummy availability key, with its Authorization header removed by a
small moat-managed in-box hook. Do not paste keys into project files or log in through Pi if you
want environment-only auth; Pi itself can save credentials when explicitly asked.

## Updates and migration

The pinned Pi version is in `lib/pins.ts`. `bundle/pi-runtime/package-lock.json` locks its complete
dependency graph and every npm archive's integrity. Change the graph and `PI_LOCK_SHA256` together;
run the keyless acceptance suite and pty test before upgrading. Unlike Codex, no built-in prompt
is vendored separately: the pinned Pi package supplies the harness prompt.

Existing environments upgrade on their next `moat up`, installing Pi and Node/npm in place and
preserving `/work`, commits, installed packages and snapshots. Older runtime files/session history
may remain as data in existing rootfs snapshots, but moat does not drive them. You do not need
`--fresh`; it would deliberately discard sandbox work.

## Budgets and limitations

Moat consumes Pi's JSON events, not a host-side agent SDK. Provider errors and aborted responses
are failures even if Pi exits zero. Cumulative streaming usage is replaced by authoritative final
usage, not added twice; reported compaction/nested-tool usage contributes too. One incremental
normalizer serves both ceilings and the footer even after raw diagnostic capture is truncated.
Tool/message text retention is bounded; an oversized event fails explicitly rather than silently
losing usage. Provider-qualified model IDs prevent another provider's same-named model from
borrowing DeepSeek prices. Reasoning is already included in Pi's output count. Cache writes are counted/priced at the input rate; providers with
separate cache-write rates need more detailed accounting.

Ceilings apply to **reported** usage for one headless invocation. Providers may report only after
completing a request. An extension can switch models or make calls without reporting usage; moat
cannot turn those into a trustworthy single-model cost or a universal spending cap. Pi's TUI has
its own usage display; moat does not impose aggregate session budgets. Use provider-side spending
limits for the hard bound. The broker's credential timestamp also bounds the ephemeral task/TUI
through a host-owned timer, not only the keepalive. This stops local processes; it does not revoke
a borrowed provider key or cancel work already accepted by the provider.

The sandbox is not a confidentiality boundary. Copied extensions can read the key and project,
and allowed network destinations can carry both out. Namespaces share the host kernel; there are
no moat-managed CPU/memory/disk quotas. See [`SPEC.md`](SPEC.md), [`VERIFICATION.md`](VERIFICATION.md)
and [`SECURITY.md`](../SECURITY.md).
