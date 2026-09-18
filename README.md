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

Then, the first time you run `moat`, it asks for your DeepSeek key, checks it
against the API, and saves it to `~/.moat/credentials.json` (mode 600):

```
$ moat
moat needs a DeepSeek API key.
  Get one at https://platform.deepseek.com/api_keys
  It will be saved to ~/.moat/credentials.json (mode 600) and sent only to https://api.deepseek.com.

  DEEPSEEK_API_KEY: ****
  checking...
  ✓ key accepted (deepseek-flash, deepseek-v4-pro), saved
```

The key is never echoed, and it is checked *before* being saved, so a typo cannot
turn into a confusing failure further along. If you would rather not store it,
`export DEEPSEEK_API_KEY=...` and moat uses that instead.

Requirements: **Linux** (WSL2 works via the container path), **Node 22.18+**, and
**unprivileged user namespaces**. No root, no Docker, no podman, no sudo. There is
no "run on the host" mode. If the host cannot support the sandbox, `moat`
refuses to run.

```bash
cd ~/code/my-project
export DEEPSEEK_API_KEY=sk-...
moat run "add a CHANGELOG, run the test suite, and commit it"
moat take                             # review it, then apply it if you like it
moat down
```

That is the whole loop. The first run detects the toolchain from the project and
remembers the model; later runs only need the task.

## DeepSeek

moat runs DeepSeek models. Export the key once and everything else follows:

```bash
export DEEPSEEK_API_KEY=sk-...
```

`moat models` lists what is available, with real context windows taken from the
[models.dev](https://models.dev) catalog that opencode is built on:

```
$ moat models
DeepSeek  env=DEEPSEEK_API_KEY  https://api.deepseek.com
  model                          context  output  tools
  deepseek-v4-flash-vision-exp      1M    384k  yes
  deepseek-v4-flash                 1M    384k  yes
 *deepseek-v4-pro                   1M    384k  yes
  deepseek-flash                    1M    384k  yes
```

`--model <id>` picks a different one. The environment remembers it, so you set it
once. `--effort low|medium|high|max|off` sets the reasoning effort for a one-off
run; inside a session, `/think` does the same thing.

`--upstream URL` keeps DeepSeek's definition — context window, price, reasoning
levels — and sends the traffic somewhere else. That is the flag for a gateway, or
for a proxy you want to watch. It is not `--base-url`: that one *replaces* the
provider, which means moat has to describe the model itself.

**`--base-url`** points the agent at any OpenAI-compatible endpoint instead, which
is how moat's own tests run against a local stub and how you would use a gateway
or a local model:

```bash
moat run --base-url http://localhost:11434/v1 --model llama3 "…"
```

Use a spend-capped key with a low limit. The agent can read it and the network is
open, which `moat doctor` will tell you plainly.

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
| `/model` | list the models, and switch: `/model deepseek-v4-flash` |
| `/think` | the reasoning effort of the current model: `/think high` |
| `/thinking` | show or hide the model's reasoning as it streams |
| `/agent` | list the agents, and switch: `/agent plan` |
| `/verbose` | show or hide each tool's output |
| `/compact` | summarise the session so far, to free up context |
| `/undo`, `/redo` | roll back the last message, and put it back |
| `/help` | the command list |
| `/stop` | abort the turn the agent is running |
| `/verify` | run the project's own tests against the agent's work |
| `/diff` | everything the agent has changed since it started |
| `/take` | bring its branch onto the host and show it |
| `/status` | model, effort, agent, branch, session, credential time left |
| `/sessions`, `/use <id>`, `/new` | move between sessions |
| `/shell` | a shell inside the sandbox; ctrl-d comes back |
| `/quit` | leave; the sandbox keeps running |

`/model` and `/think` read their options from the server rather than from a list
moat keeps, so you are only ever offered a model that exists and a reasoning
level that model actually accepts. DeepSeek's models are reasoning models, and
they do not all take the same levels:

```
› /model

     1. deepseek/deepseek-flash                1M ctx · reasoning  effort: off low high max
     2. deepseek/deepseek-v4-flash             1M ctx · reasoning  effort: off low high max  retired name
     3. deepseek/deepseek-v4-flash-vision-exp  1M ctx · reasoning  effort: off low high max  retired name
  ›  4. deepseek/deepseek-v4-pro               1M ctx · reasoning  effort: off high max

  switch with /model <number or name>

› /think

    off  answer without thinking
    high
  › max
    default (whatever the model does on its own)

  set with /think <level>, or /think default to clear
```

Two of those four are names DeepSeek has retired: they still work, but the
requests are served by the current Flash model and billed at its price, so moat
says so rather than presenting four live models. `/think off` turns thinking off
entirely, which is a different thing from `low` — DeepSeek's effort scale has no
"off" in it, and the weakest level still thinks.

Both are remembered per project, so the next `moat` (and `moat run`) in that
directory starts on the same model and effort. Leaving effort unset lets the
model decide for itself.

### What a turn looks like

```
› add a test for the empty string

  ✓ read       src/slugify.js                                            0.4s
  ✓ edit       src/slugify.js  +3 -1                                     0.7s
  ✓ bash       npm test                                                  2.1s
│   Added a case for `""` and made the pattern tolerate it.
│
│   ┌─ js
│   │ return input.trim().replace(/\s+/g, "-")
│   └─

  ─ 8.9k in · 2.3k cached · 61 out · 6 tools · 3.6s  1% of context  $0.0044 off-peak
```

Each tool call is one row that updates in place — it starts as a spinner and ends
with its elapsed time, rather than printing twice. A file change shows how many
lines it added and removed. The answer is rendered as markdown.

The footer is the honest accounting, and it is deliberately more detailed than a
single number:

- **in** counts the whole prompt; **cached** is the part DeepSeek served from its
  context cache, which costs about thirty times less, so the split is the
  difference between a cheap turn and an expensive one.
- **reasoning** is listed separately because those tokens are billed at the
  output rate and are otherwise invisible.
- **peak / off-peak** is named because the identical turn costs twice as much
  during DeepSeek's peak hours (01:00–04:00 and 06:00–10:00 UTC, Mon–Fri).

The prices come from DeepSeek's published table, not from the model catalog
opencode bills against — that catalog has `deepseek-v4-pro` at roughly a third of
its real price and no notion of peak hours at all. A model with no published
price says `cost unknown` rather than showing a number moat made up.

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

## It proves its work

An agent saying "the tests pass" is a claim. moat finds the project's own checks
from `package.json` scripts, a `Makefile`, `pyproject.toml`, `Cargo.toml` or
`go.mod`, hands them to the agent so it runs *your* commands, and runs them itself
once the work is done:

```
$ moat take
  moat-session-2026-09-18-19-30  2 commit(s), 72fc923e48f5
    72fc923e48  slugify: handle whitespace, punctuation and accents

   src/slugify.js | 7 ++++++-
   1 file changed, 6 insertions(+), 1 deletion(-)
  → verifying: npm run test

    pass  npm test                 0.3s

    checks:  npm test passed
    your working tree is untouched
    accept:  moat apply moat-session-2026-09-18-19-30 --checkout
```

No model is involved in that verdict. `moat verify` runs the same checks on
demand, and `/verify` does it without leaving the session.

## It can ask you things

In an interactive session the agent may stop and ask, when the answer would
change what it builds:

```
› make the migration

  ? Which database should the new migration target?
    1. postgres           Add a Postgres migration
    2. sqlite             Add a SQLite migration
  a number 1-2, a label, or type your own answer
› 2
  answered
  ✓ question  Asked 1 question
  ✓ bash      git commit -m "add migration"
```

Unattended runs are told plainly that nobody will answer, and if the agent stops
to ask anyway the turn ends with an explanation instead of hanging until a
timeout.

## Limitations

- **The credential is readable by the agent** and, with egress open, exfiltratable.
  There is no in-sandbox fix: a process that must use a credential cannot hide it
  from code running as the same uid. Use a spend-capped key with a low limit.
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
