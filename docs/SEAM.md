# The harness boundary

moat has one harness: **Pi**. It is driven as a CLI, not embedded on the host.
The older multi-runtime analysis is retained at
[`archive/SEAM-multi-runtime.md`](archive/SEAM-multi-runtime.md).

## Responsibilities

| Pi, inside the box | moat, on the host |
| --- | --- |
| Agent loop, built-in tools and custom tools | Provision, copy-in and namespace lifecycle |
| Project extensions, skills, prompts and MCP processes | Environment-only credential injection |
| Model transport and conversational sessions | Chosen egress policy and credential deadline |
| Its own TUI or LF-framed JSON events | Pty attachment, sanitized reports, reported-usage ceilings |
| Working-tree edits and commits | Hardened Git copy-out, attribution, review and explicit apply |

Loading Pi's SDK or an extension on the host to redirect only selected tools would violate this
boundary: extensions can execute code directly, without going through a redirected tool.

## Implementation

* `sandbox/pi-install.ts`: dependency-lock verification, per-artifact integrity, platform selection,
  cached assembly and guarded in-place installation. No npm lifecycle scripts run on the host.
* `bundle/pi.ts`: sandbox-local settings/model/brief installation, CLI bodies, keyless header hook
  and Pi event normalization. Project customization stays in the copied `.pi` directory.
* `bundle/runtime.ts`: the one Pi CLI adapter and runtime-neutral keepalive.
* `bundle/turn.ts`: the host's tool/message/usage/error reporting contract.

The parser ignores unknown records, counts authoritative messages only once, distinguishes a
successful retry from a final error, and prices neither cache hits as misses nor reasoning twice.
Pi can report a failed response while exiting zero: process status alone is not a task verdict.

The extensibility surface is Pi's, not another plugin API invented by moat. Compatibility still
needs measurement: an extension can block, need unavailable network access, register another
provider, or make model calls whose usage never appears in Pi's stream. See [`PI.md`](PI.md) and
[`SPEC.md`](SPEC.md).
