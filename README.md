# moat

[![ci](https://github.com/nochinsky/moat/actions/workflows/ci.yml/badge.svg)](https://github.com/nochinsky/moat/actions/workflows/ci.yml)

Run an AI coding agent in a disposable Linux sandbox. Your working directory is
never touched, and the agent never asks for permission.

`moat` copies your project into a fresh rootfs, runs
[Codex CLI](https://github.com/openai/codex) inside it, and copies the work back out
only when you ask. `--runtime opencode` selects the older server-based runtime instead.
The sandbox is built from `unshare` and `chroot` directly: no Docker, no podman, no
daemon, nothing to install.

## Install

Linux (WSL2 works), Node 22.18+, and unprivileged user namespaces. No root.

```bash
git clone https://github.com/nochinsky/moat.git
cd moat && npm install && npm link
moat doctor
```

`moat doctor` checks that the host can support the sandbox, then measures and
prints what the sandbox does *not* protect. Read that before trusting it.

## Use

```bash
cd ~/code/my-project
moat
```

That opens the agent's own TUI (Codex's, on a pty inside the box). Type what you want and
watch it happen. When you are happy:

```bash
moat take     # fetch the work, run the project's own tests, apply it if you accept
moat down
```

Nothing reaches your directory until you accept it. `moat run "<task>"` does the same
thing non-interactively: it drives one turn and prints what happened — the tools it ran,
the answer, and the tokens and cost that turn used — then exits. At a terminal it opens
the TUI with the task as its first message instead.

The first time you run it, moat asks for a DeepSeek key, checks it against the
API before saving it to `~/.moat/credentials.json` (mode 600), and reuses it
after that. `export DEEPSEEK_API_KEY=...` skips the prompt.

## Read this before using it

The sandbox contains your **host**. It does not keep secrets from the agent.

- The agent can read the credential, because it has to in order to call the model.
- Egress is open, so anything it can read it can also send.

Use a short-lived, spend-capped, project-scoped key rather than a general-purpose
one. `moat doctor` measures all of this and prints it whenever a sandbox is up.

## Commands

Four are the loop:

```
moat              open a session here, booting the box if needed
moat run "<task>" boot, do the task, stream the work
moat take         fetch the work, run the project's checks, apply on request
moat down         stop the box; nothing is lost
```

Inside a session you are in Codex's TUI, which has its own commands (`/model`, `/compact`,
`/new`, `/init`, `/help`; approvals are already off). moat's own verbs stay outside it —
`moat fetch`, `moat apply`, `moat verify`, `moat take`, `moat exec`, `moat shell`.

Non-interactively, a turn looks like this (real capture, live suite section 7):

```
$ moat run "Create a file named CODEX-LIVE.txt in the working tree whose contents are
            exactly: codex live. Do not modify any other file. Then finish."
  ✓ /bin/sh -lc "printf 'codex live\n' > CODEX-LIVE.txt && cat CODEX-LIVE.txt"
  ✓ /bin/sh -lc "printf 'codex live' > CODEX-LIVE.txt && wc -c < CODEX-LIVE.txt"
Created `CODEX-LIVE.txt` in `/work` containing exactly `codex live` (no trailing newline).

  27360 tokens  $0.0006 off-peak  2 tools
```

With `--runtime opencode` you get moat's own session instead, with `/diff`, `/take`,
`/verify`, `/model`, `/think`, `/undo` and the rest (see `docs/SPEC.md` §6b.5).

`moat --help` lists the rest: `attach`, `shell`, `exec`, `fetch`, `apply`,
`snapshot`, `restore`, `profiles`, `models`, `tools`, `env`, `logs`, `destroy`.
`attach`, `tools` and `env` need the opencode runtime: they ask its server.

## DeepSeek

moat targets one provider. `moat models` lists what is available, with context windows
and prices read from the [models.dev](https://models.dev) catalog moat ships:

```
$ moat models
DeepSeek  env=DEEPSEEK_API_KEY  https://api.deepseek.com
  model                          context  output  tools
  deepseek-v4-flash-vision-exp      1M    384k  yes
  deepseek-v4-flash                 1M    384k  yes
  deepseek-v4-pro                   1M    384k  yes
 *deepseek-flash                    1M    384k  yes

  * = default. Override with: moat run --model <id> "..."
```

`deepseek-flash` at `high` reasoning is the default, and the environment
remembers whatever you change it to. Two of those four are retired names:
DeepSeek still accepts them, but serves them with the current Flash model at the
Flash price, which is what `deepseek-flash` names directly — so that is the one
moat uses.

`--model <id>` picks a model. `--effort <level>` sets reasoning effort under the
opencode runtime (`--runtime opencode`, where `/model` and `/think` do the same inside a
session). Under the codex runtime it is **refused rather than ignored**: Codex renders
reasoning as `model_reasoning_effort`, but drops it for models it has no metadata for, and
that is every DeepSeek model today — measured, `model_reasoning_effort = "high"` never
reaches the wire for `deepseek-flash`. A flag that silently does nothing is the bug this
project keeps finding; it fails instead.

`--upstream URL` keeps DeepSeek's definition and sends the traffic somewhere else,
for a gateway or a proxy you want to watch. `--base-url URL` instead points at any
OpenAI-compatible endpoint, which is how the test suite runs against a local stub:

```bash
moat run --base-url http://localhost:11434/v1 --model llama3 "…"
```

## Sandbox profiles

The base image boots in seconds. Toolchains are installed on demand with the
sandbox's own package manager, cached per package set, and kept in the rootfs:

```
node      Node.js / TypeScript        python    Python + pip + venv + uv
cc        C / C++ toolchain           go        Go
rust      Rust + cargo                java      JDK 21
db        PostgreSQL, SQLite, Redis   net       ssh, dig, nc, socat, tcpdump
browser   headless Chromium           cli       gh, git-lfs, tmux, vim, yq
full      everything
```

Most projects need none of them: moat reads `package.json`, `pyproject.toml`,
`go.mod`, `Cargo.toml` or a `Makefile` and picks one. `moat profiles` describes
them.

## How it works

```
unshare --user --map-root-user --mount --pid --fork --uts --ipc [--net] --kill-child
  └─ mount --make-rprivate /          # nothing propagates back to the host
     mount --bind <rootfs> <mnt>      # the sandbox root is a mount we own
     mount -t proc / tmpfs /dev / devpts / /dev/shm / /tmp / /run
     bind device nodes (read-write)   # interfaces, not host data
     nft -f /.moat/egress.nft         # default drop: provider + registries only
     chroot <mnt> && exec /.moat/entry.sh
        ├─ codex runtime (default)  # a CLI: the long-running box is a keepalive, and
        │                           # every task, check and TUI boots its own ephemeral box
        └─ opencode runtime         # opencode serve --port N --hostname 0.0.0.0
              ↑ the host reaches it through slirp4netns (API socket, add_hostfwd)
```

Under the opencode runtime the host talks to the agent over HTTP, through an explicit port
forward when the box has its own network namespace; under the codex runtime the host attaches
a terminal to the TUI or reads the JSONL of `codex exec`. Either way the agent loop, its tools
and the filesystem live inside the box, and nothing is proxied. Copy-in is a `git
clone --no-hardlinks`, so the project arrives as data rather than as a mount.

The default network policy is `filtered`: the sandbox is in its own namespace
(`--net`), slirp4netns is its only datapath, the host's loopback is closed on
both routes, and an nftables allowlist drops everything except the provider and
the package registries. `moat doctor` measures all of it.

The agent works on its own branch, and moat runs the project's own checks against
the result before showing it to you. No model is involved in that verdict.

## Limitations

- The credential is readable by the agent. Egress is fenced by default, but not
  sealed: an allowlisted address, or DNS, can still carry data out, and the agent
  is root in the box, so it can flush the ruleset it runs under (measured). The
  fence bounds where the box sends data during normal work, not a hostile agent.
  Copy-out compares what it carries against the credential moat holds and names
  the files that contain it (`moat fetch` and `moat apply`), but that is a
  warning, not a gate: content you asked for still crosses.
- The allowlist is an IP snapshot resolved when the box boots, so a host that
  rotates to an address outside it is unreachable until the next `moat up`, and
  it cannot express per-host ports. `moat up --egress isolated` drops the
  ruleset; `--egress open` restores the host's network namespace, and moat
  chooses that automatically for a provider on the host's loopback, which the
  sandbox's own namespace cannot reach. v1 is planned as a microVM.
- Under the opencode runtime the tool list cannot be pruned exactly (opencode 1.18.31), so
  the bundle refuses to execute anything outside the curated set instead and `moat tools`
  prints the gap. Under the codex runtime the tool set is Codex's own — `exec_command`,
  `write_stdin`, `view_image`, its planning tools and a server-side `web_search` — and moat
  renders the config that governs it (`approval_policy = "never"`,
  `sandbox_mode = "danger-full-access"`) rather than claiming a curated list it does not own.
- Gitignored paths are not copied in. No `node_modules`, no `.venv`.
- Linux only. No Windows.

## Docs

- [`docs/SPEC.md`](docs/SPEC.md) — the contract: lifecycle, copy-in and copy-out,
  the credential rule, the isolation model, and what v0 does not do.
- [`docs/VERIFICATION.md`](docs/VERIFICATION.md) — each claim with the command
  that produced it and its real output.
- [`docs/UPSTREAM-CANDIDATES.md`](docs/UPSTREAM-CANDIDATES.md) — the opencode
  changes moat would like. Not applied.
- [`docs/RUNTIME-COST.md`](docs/RUNTIME-COST.md) — what a turn costs on each runtime,
  measured on the same task (Codex ≈ 2.8× on trivial work).
- [`docs/RUNTIME-MIGRATION.md`](docs/RUNTIME-MIGRATION.md) — what removing opencode will
  remove, and the order that keeps the suites green.
- [`docs/RUNTIME-SPIKE-codex.md`](docs/RUNTIME-SPIKE-codex.md) — the measurements behind the
  codex runtime: the musl binary, the Responses wire, the two gotchas.
- [`AGENTS.md`](AGENTS.md) — for anyone working on moat itself: the invariants, the
  layout, the traps, and what is deliberately not built yet.

## Development

```bash
bash test/e2e.sh                              # acceptance criteria, ~4 minutes
bash test/e2e-extras.sh                       # snapshots, apply, credential expiry
DEEPSEEK_API_KEY=... bash test/e2e-live.sh    # a real model doing a real task
```

The first two drive real sandboxes against deterministic local model stubs — chat
completions for opencode, and (`test/mock-responses.mjs`) the Responses wire API for Codex,
whose event shapes were captured from a real DeepSeek stream — so they need no key and give
the same result every time. Raw output lands in `test/evidence/`.

Run them locally. GitHub's hosted runners cannot create unprivileged user
namespaces, so the sandbox suite does not run in CI; the workflow reports that as
a warning rather than pretending the suite ran.

MIT.
