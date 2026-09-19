# moat

[![ci](https://github.com/nochinsky/moat/actions/workflows/ci.yml/badge.svg)](https://github.com/nochinsky/moat/actions/workflows/ci.yml)

Run an AI coding agent in a disposable Linux sandbox. Your working directory is
never touched, and the agent never asks for permission.

`moat` copies your project into a fresh rootfs, runs
[opencode](https://github.com/sst/opencode) inside it, and copies the work back
out only when you ask. The sandbox is built from `unshare` and `chroot` directly:
no Docker, no podman, no daemon, nothing to install.

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

That opens a session. Type what you want and watch it happen. When you are happy:

```bash
moat take     # fetch the work, run the project's own tests, apply it if you accept
moat down
```

Nothing reaches your directory until you accept it. `moat run "<task>"` does the
same thing non-interactively: at a terminal it drops you into the session when
the task is done, and piped it streams and exits.

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

Inside a session:

| | |
| --- | --- |
| `/model`, `/think` | which model, and how hard it thinks |
| `/thinking`, `/verbose` | show the model's reasoning, or each tool's output |
| `/diff`, `/take`, `/apply` | what changed, and how to bring it across |
| `/verify` | run the project's own tests against the work |
| `/undo`, `/redo`, `/compact` | roll back a message, put it back, summarise |
| `/status`, `/sessions`, `/new`, `/use` | where you are |
| `/shell`, `/stop`, `/quit` | a shell in the box, interrupt, leave |

```
› the tests are failing. Fix slugify so they pass, and commit it.

  ✓ bash       git status && git log --oneline -5                                             155ms
  ✓ read       src/slugify.js                                                                  11ms
  ✓ edit       src/slugify.js                                                            +1 -1 21ms
  ✓ bash       npm test                                                                       273ms
  ✓ bash       git add src/slugify.js && git commit -m "Fix slugify to collapse whitespace a…  32ms
│   Fixed src/slugify.js:2 to trim and collapse whitespace, tests pass (2/2), committed.

  ─ 57k in · 50k cached · 462 out · 44 reasoning · 8 tools · 12s  6% of context  $0.0070 off-peak
```

`moat --help` lists the rest: `attach`, `shell`, `exec`, `fetch`, `apply`,
`snapshot`, `restore`, `profiles`, `models`, `tools`, `env`, `logs`, `destroy`.

## DeepSeek

moat targets one provider. `moat models` lists what is available, with context
windows read from the [models.dev](https://models.dev) catalog opencode is built
on:

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

`--model <id>` picks a model and `--effort <level>` sets how hard it reasons for
a single run. Inside a session, `/model` and `/think` do the same thing, and
`/think off` turns thinking off entirely — which is not the same as `low`, since
the weakest level on DeepSeek's scale still thinks.

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
        └─ opencode serve --port N --hostname 0.0.0.0
              ↑ the host reaches it through slirp4netns (API socket, add_hostfwd)
```

The host talks to the agent over HTTP, through an explicit port forward when the
box has its own network namespace. The agent loop, its tools and the filesystem
all live inside the box; nothing is proxied. Copy-in is a `git
clone --no-hardlinks`, so the project arrives as data rather than as a mount.

The default network policy is `filtered`: the sandbox is in its own namespace
(`--net`), slirp4netns is its only datapath, the host's loopback is closed on
both routes, and an nftables allowlist drops everything except the provider and
the package registries. `moat doctor` measures all of it.

The agent works on its own branch, and moat runs the project's own checks against
the result before showing it to you. No model is involved in that verdict.

## Limitations

- The credential is readable by the agent. Egress is fenced by default, but not
  sealed: an allowlisted address, or DNS, can still carry data out.
- The allowlist is an IP snapshot resolved when the box boots, so a host that
  rotates to an address outside it is unreachable until the next `moat up`, and
  it cannot express per-host ports. `moat up --egress isolated` drops the
  ruleset; `--egress open` restores the host's network namespace, and moat
  chooses that automatically for a provider on the host's loopback, which the
  sandbox's own namespace cannot reach. v1 is planned as a microVM.
- The tool list cannot be pruned exactly in opencode 1.18.31. The bundle refuses
  to execute anything outside the curated set instead, and `moat tools` prints the
  gap.
- Gitignored paths are not copied in. No `node_modules`, no `.venv`.
- Linux only. No Windows.

## Docs

- [`docs/SPEC.md`](docs/SPEC.md) — the contract: lifecycle, copy-in and copy-out,
  the credential rule, the isolation model, and what v0 does not do.
- [`docs/VERIFICATION.md`](docs/VERIFICATION.md) — each claim with the command
  that produced it and its real output.
- [`docs/UPSTREAM-CANDIDATES.md`](docs/UPSTREAM-CANDIDATES.md) — the opencode
  changes moat would like. Not applied.
- [`AGENTS.md`](AGENTS.md) — for anyone working on moat itself: the invariants, the
  layout, the traps, and what is deliberately not built yet.

## Development

```bash
bash test/e2e.sh                              # acceptance criteria, ~4 minutes
bash test/e2e-extras.sh                       # snapshots, apply, credential expiry
DEEPSEEK_API_KEY=... bash test/e2e-live.sh    # a real model doing a real task
```

The first two drive real sandboxes against a deterministic local model stub, so
they need no key and give the same result every time. Raw output lands in
`test/evidence/`.

Run them locally. GitHub's hosted runners cannot create unprivileged user
namespaces, so the sandbox suite does not run in CI; the workflow reports that as
a warning rather than pretending the suite ran.

MIT.
