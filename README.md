# moat

[![ci](https://github.com/nochinsky/moat/actions/workflows/ci.yml/badge.svg)](https://github.com/nochinsky/moat/actions/workflows/ci.yml)

Run an AI coding agent inside a disposable, fully isolated Linux box.

`moat` copies your project into a fresh sandbox with its own rootfs and package
manager, runs [opencode](https://github.com/sst/opencode) inside it with **zero
permission prompts**, and copies the agent's work back out only when you ask.
Your machine is never touched, not by a bind mount, not by a forwarded
credential, not by the agent's writes.

> **Your host holds everything you would miss. The box holds a copy.**

Be precise about the second half: the box holds a copy of your project *and a live
credential*, the agent can read both, and egress is open. moat is a containment
boundary for your **host**, not a confidentiality boundary for your **project** or
your **key**. `moat doctor` measures and prints all of it:

```
exposures — measured, and NOT fixed in v0. Read these before trusting the box.
  expose  credential visible to the agent
  expose  host loopback reachable
  expose  egress unrestricted
```

**So: give moat a short-lived, spend-capped, project-scoped token, not your
general-purpose provider key.** moat will not silently pick one up from your
environment. Full reasoning: [`docs/SPEC.md` §1](docs/SPEC.md).

---

## Quick start

```bash
git clone https://github.com/nochinsky/moat.git && cd moat
npm install
npm link                 # puts `moat` on your PATH
moat doctor              # checks the host can support it, and shows the exposures
```

Requirements: **Linux** (WSL2 works via the container path), **Node 22.18+**, and
**unprivileged user namespaces**. No root, no Docker, no podman, no sudo. There is
no "run on the host" mode. If the host cannot support the sandbox, `moat`
refuses to run.

```bash
cd ~/code/my-project

# GLM (Z.AI)
export ZHIPU_API_KEY=...
moat up --provider zai --model glm-4.6 --profile node

# DeepSeek
export DEEPSEEK_API_KEY=...
moat up --provider deepseek --model deepseek-v4-pro --profile node,python

# OpenAI
export OPENAI_API_KEY=...
moat up --provider openai --model gpt-5.4 --profile full

moat attach --prompt "add a CHANGELOG, run the test suite, and commit it"
moat fetch                       # the agent's branch lands in refs/moat/*; your tree is untouched
moat apply <branch> --checkout   # an explicit, separate second step
moat down
```

`moat models` shows what a provider actually offers, with real context windows.

## Providers

| `--provider` | env var | notes |
| --- | --- | --- |
| `zai` | `ZHIPU_API_KEY` | GLM-4.6, GLM-5.x, GLM-4.5-air… |
| `deepseek` | `DEEPSEEK_API_KEY` | deepseek-v4-pro, deepseek-v4-flash |
| `openai` | `OPENAI_API_KEY` | gpt-5.x, gpt-4.1 |
| `anthropic` | `ANTHROPIC_API_KEY` | native SDK |
| `openrouter` | `OPENROUTER_API_KEY` | one key, many models |
| `groq` | `GROQ_API_KEY` | |
| `moonshot` | `MOONSHOT_API_KEY` | Kimi |
| `local` |, | Ollama, llama.cpp, vLLM, LiteLLM: `--provider-base-url http://…/v1` |

moat is built on opencode, which is built on the [models.dev](https://models.dev)
catalog, 222 providers with maintained context limits, output limits and
tool-call support. For a catalog provider moat writes **no provider block at all**:
it injects the credential under the name opencode expects and lets opencode supply
the accurate metadata. Guessing a context window wrong means compacting at the
wrong moment, so moat does not guess.

## Toolchain profiles

The base image is small and boots in seconds. Anything else is one flag away,
installed with the sandbox's own package manager, cached per package set, and
persisted in the rootfs, so adding a profile later costs only what is missing.

```
node      Node.js / TypeScript        python    Python + pip + venv + uv
cc        C / C++ build toolchain     go        Go
rust      Rust + cargo                java      JDK 21
db        PostgreSQL, SQLite, Redis   net       ssh, dig, nc, socat, tcpdump
browser   headless Chromium           cli       gh, git-lfs, tmux, vim, yq
full      everything
```

`db` ships *servers*, not just clients, so the agent can start a real PostgreSQL
and test against it instead of a mock. State lives in the rootfs and persists.

## Commands

| | |
| --- | --- |
| `moat up` | provision if needed, copy in, mint a credential, boot, wait for ready |
| `moat attach [--prompt TEXT]` | drive a session; `--continue` resumes the last one; `--show-output` prints tool output |
| `moat fetch [branch]` | `git fetch` the agent's branch from the sandbox into `refs/moat/*` |
| `moat apply <branch> [--checkout]` | turn a fetched ref into a local branch |
| `moat status [--all]` | state, endpoint, model, branch, profiles, credential expiry |
| `moat down` / `moat destroy` | stop (keep everything) / delete the environment |
| `moat snapshot` / `moat restore` | rootfs snapshots, never the project |
| `moat exec -- <cmd>` / `moat shell` | run one command / open a shell inside the sandbox |
| `moat models [provider]` | what the catalog offers, with context windows |
| `moat profiles` | toolchain profiles and base packages |
| `moat doctor` | host probe, 14 isolation assertions, and the measured exposures |
| `moat tools` | the bundle, the registry, and the measured gap between them |
| `moat env` / `moat logs` | connection details / tail a log |

## How it works

```
unshare --user --map-root-user --mount --pid --fork --uts --ipc --kill-child
  └─ mount --make-rprivate /          # nothing propagates back to the host
     mount --bind <rootfs> <mnt>      # the sandbox root is a mount we own
     mount -t proc / tmpfs /dev / devpts / /dev/shm / /tmp / /run
     bind read-only device nodes      # the only host-originated mounts
     chroot <mnt> && exec /.moat/entry.sh
        └─ opencode serve --port N --hostname 127.0.0.1
```

No Docker, no podman, no container runtime. The host talks to the agent over
HTTP on loopback, the agent loop, the tools and the filesystem all live inside
the box, and **nothing is proxied**.

The agent gets an environment brief at `/root/.config/opencode/AGENTS.md` telling
it where it is, that it may install and break anything, that nobody will answer a
question, that it should run the tests, and that the credential in its
environment must never be printed or exfiltrated. It works on its own git branch
(`moat/session-<timestamp>`) so your branch is untouched inside the box too.

## Limitations

- **The credential is readable by the agent** and, with egress open, exfiltratable.
  There is no in-sandbox fix: a process that must use a credential cannot hide it
  from code running as the same uid. Use a disposable token.
- **The network is not fenced.** Restricting it is v2, and it is hard to do
  rootless, the reason v1 is planned as a microVM.
- **The tool set cannot be pruned exactly.** opencode 1.18.31 offers no supported
  way to remove a built-in from the model-facing list; the bundle refuses to
  *execute* anything outside the curated set instead. `moat tools` prints the gap.
  See [`docs/UPSTREAM-CANDIDATES.md`](docs/UPSTREAM-CANDIDATES.md).
- **No Windows.** Linux only, WSL2 via the container path.
- **gitignored paths are not copied in**, no `node_modules`, no `.venv`. That is
  the point of a fresh box, but it will surprise someone expecting a faithful
  clone.

## Verify it yourself

```bash
bash test/e2e.sh          # the acceptance criteria, ~4 minutes
bash test/e2e-extras.sh   # snapshots, apply, credential expiry
DEEPSEEK_API_KEY=... bash test/e2e-live.sh   # a real model doing a real task
```

The first two drive real agent sessions inside a real sandbox against a
deterministic local model stub, so they need no API key and produce the same
result every time. The third spends real tokens against a real provider, and
refuses to run without a key rather than skipping quietly. Raw output from all
three is in `test/evidence/`, and `docs/VERIFICATION.md` quotes it.

**Run them on your own machine, not in CI.** GitHub's hosted runners cannot
create unprivileged user namespaces at all: `max_user_namespaces` is fine and the
AppArmor restriction can be lifted with sudo, but `unshare` is killed silently by
the runner's own confinement, and there is no way to change that from inside a
job. The CI workflow says so in a warning annotation instead of pretending a suite
ran. CI covers the build, the CLI, the model catalog and the profiles; the sandbox
suite is local-only, and that is a real gap rather than a hidden one.

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md), the contract: lifecycle, copy-in/copy-out, the
  credential axiom, the isolation model, and what v0 does **not** do.
- [`docs/VERIFICATION.md`](docs/VERIFICATION.md), every acceptance criterion with
  the command that produced it and its real output, starting with the exposures.
- [`docs/UPSTREAM-CANDIDATES.md`](docs/UPSTREAM-CANDIDATES.md), the opencode
  changes moat would like, with file, line and diff-size estimates. Not applied.

## Layout

```
cmd/       the moat CLI — all UX lives here
sandbox/   rootfs, namespaces, profiles, snapshots, isolation checks
sync/      copy-in and copy-out
secrets/   the credential broker
bundle/    the rendered opencode config, the plugin, and the agent brief
lib/       providers, the models.dev catalog, host probe, hashing
docs/      SPEC, VERIFICATION, REPORT, UPSTREAM-CANDIDATES
test/      the mock model, scenarios, and the two verification suites
```

MIT licensed.
