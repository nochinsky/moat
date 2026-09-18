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
export DEEPSEEK_API_KEY=sk-...        # or ZHIPU_API_KEY, or OPENAI_API_KEY
moat run "add a CHANGELOG, run the test suite, and commit it"
moat take                             # review it, then apply it if you like it
moat down
```

That is the whole loop. The first run picks the provider from whichever key you
exported and detects the toolchain from the project; later runs only need the
task. `moat models` shows what a provider actually offers, with real context
windows, and `moat run --provider zai --model glm-4.6` overrides the defaults
when you want something specific.

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

Four of them matter. The rest exist so you never have to reach for anything else.

```
moat run "<task>"     boot if needed, do the task, stream the work
moat take             review what the agent did, and apply it if you want
moat down             stop the sandbox; nothing is lost
moat status           what is running, on which model, with how much time left
```

At a terminal, `moat run` doesn't just print and exit: it drops you into a
session where you can watch the agent work and talk to it while it does. Anything
you type is sent to the agent; if it is mid-turn your message queues and lands at
the next step, and ctrl-c interrupts the turn without losing the session.

```
$ moat run "the tests are failing, fix them"
› moat · deepseek/deepseek-v4-pro · ~/code/slugkit
› type a task and press enter. /help for commands, ctrl-c to interrupt.

  · bash      npm test
  ✓ bash      npm test
  ✓ read      src/slugify.js
  ✓ edit      src/slugify.js
  ✓ bash      npm test
│ The bug was the naive `replace(/ /g, "-")`, which does not collapse runs of
│ whitespace or trim. Fixed in slugify.js and the suite is green.
  ✓ bash      git commit -m "fix slugify whitespace handling"

› also add a test for the empty string        ← typed while it was working
  queued, the agent will pick this up when the current step finishes
  · read      test/slugify.test.js
  ...
```

| command | |
| --- | --- |
| `/help` | the command list |
| `/stop` | abort the turn the agent is running |
| `/diff` | everything the agent has changed since it started |
| `/take` | bring its branch onto the host and show it |
| `/status` | model, branch, session, credential time left |
| `/sessions`, `/use <id>`, `/new` | move between sessions |
| `/shell` | a shell inside the sandbox; ctrl-d comes back |
| `/quit` | leave; the sandbox keeps running |

Piping `moat run` output somewhere keeps it non-interactive, so scripts are
unaffected. `--no-follow` forces that even at a terminal.

`moat run` reads the project and picks the toolchain itself: `package.json` means
the node profile, `pyproject.toml` means python, `go.mod` means go, a `Makefile`
means a C toolchain. It also remembers the provider and model from the last run,
so you type the flags once and then not again.

```
$ cd ~/code/some-project
$ export DEEPSEEK_API_KEY=sk-...
$ moat run "the tests are failing, fix them and commit"
  detected: package.json -> node
  ✓ image provisioned in 8.0s
  ✓ copy-in via git: 42 files
  model: deepseek/deepseek-v4-pro (context 1M, out 384k)
  [tool] bash (running) npm test
  [tool] bash (completed) npm test
  ...
$ moat take
  moat-session-2026-09-18-18-20  2 commit(s), b63eb2d9665e
    b63eb2d9  fix slugify whitespace handling
    5806abcd  initial commit

   src/slugify.js | 7 ++++++-
   1 file changed, 7 insertions(+)

    your working tree is untouched
    accept:  moat apply moat-session-2026-09-18-18-20 --checkout
    reject:  git update-ref -d refs/moat/moat-session-2026-09-18-18-20
```

Everything else, roughly grouped:

| | |
| --- | --- |
| **Attaching** | `moat attach` opens opencode's own TUI against the running box; `moat shell` gives a plain shell inside it; `moat exec -- <cmd>` runs one command; `--continue` on `run` resumes the last session instead of starting a new one |
| **Branches** | `moat fetch [branch]` (add `--commit-worktree` to include work the agent left uncommitted); `moat apply <branch> [--checkout]` |
| **Environment** | `moat up [task]` starts a box without a task; `moat profiles`; `moat models [provider]`; `moat destroy`; `moat snapshot` / `moat restore` |
| **Diagnostics** | `moat doctor` (host support, 14 isolation checks, and the measured exposures); `moat tools`; `moat env`; `moat logs` |

Run `moat --help` for the full list with the flags.

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
