# moat, specification (v0)

> Sandbox always. Permissions never needed.

moat runs an AI coding agent inside a disposable, fully isolated Linux box. The
host is never touched, not by a bind mount, not by an environment variable, not
by a forwarded credential, not by the agent's writes.

This document is the contract. It describes what v0 does, and it is explicit
about the places where v0 falls short of the design goals, with the
evidence for each.

---

## 1. The design axiom

> **The host holds everything the user would miss. The box holds a copy.**

That is the accurate version, and it is what makes autonomy defensible. It is
tempting to go further and say the box "contains nothing worth protecting from the
agent". That is false, and the difference matters, so here it is in full.

### 1.1 What the sandbox protects

Verified in `docs/VERIFICATION.md` §4:

* your filesystem outside the project, `$HOME`, your other repositories, dotfiles
* your SSH keys and agent socket
* your cloud credentials, tokens and environment
* your machine's integrity: every namespace differs from the host's
* your project's **integrity**: the host copy is authoritative, the agent works on
  a copy, and nothing is applied back without an explicit `moat fetch` +
  `moat apply`

That is a large improvement over running an agent, and its `npm install`
postinstall scripts, directly on your machine.

### 1.2 What the sandbox does NOT protect

Measured, not assumed (`moat doctor` prints all three on every run):

* **The credential.** It is in the agent's process environment. The bundle blanks
  secret-looking variables for shell commands the agent writes, but the value
  remains in the opencode process environment and any process running as the same
  uid can read it from `/proc/<pid>/environ`. **You cannot hide a credential from
  a process that must use it, running as the same uid inside the box.** Every
  in-sandbox mitigation is a speed bump.
* **The project's confidentiality.** The agent can read every byte of the copy,
  and egress is open, so it can send them anywhere.
* **Your host's loopback.** The sandbox shares the host's network namespace in
  v0, so every service you are running locally, databases, dev servers,
  notebooks, the model endpoint, is reachable from inside.

### 1.3 Why autonomy is still the right default

Because none of the three exposures above is fixed by a permission prompt. All
three are reachable through a single `bash` call, which is a curated tool the
agent legitimately needs. Adding deny rules or approval prompts would not stop
the exfiltration; it would only make the agent ask first, which is exactly the
interaction this product exists to remove.

The lever is therefore not the tool list. It is:

1. **What the credential can do at the provider.** Hand the box a short-lived,
   spend-capped, narrowly scoped token, so that stealing it is not worth the
   effort. moat enforces a TTL (§5.3) and refuses to silently pick up a
   general-purpose key from your environment, but provider-side scoping is the
   control that matters and it is v2 work.
2. **Egress policy.** Restricting where the box can talk is the only thing that
   actually stops exfiltration. It is v2, and it is hard to do rootless, see
   §7.3.
3. **Choosing not to put things in the box.** `moat up` names any copied-in file
   that looks like it holds a credential.

**In one line:** moat is a containment boundary for your *host*, not a
confidentiality boundary for your *project* or your *credential*. If you need the
latter, wait for v2's egress policy or use `moat up --no-credential` and drive the
agent with something you do not mind losing.

## 2. Lifecycle

### 2.1 Environment identity

An environment is keyed by the SHA-256 of the project directory's real path
(`lib/paths.ts:projectId`), truncated to 12 hex characters. `~/.moat/envs/<id>/`
holds everything:

```
~/.moat/
  cache/rootfs/alpine-3.21.4-x86_64.tar.gz      # host-side artefact cache
  cache/opencode/1.18.31/linux-x64-musl/opencode
  envs/<id>/
    state.json          # metadata; contains a credential *fingerprint*, never a value
    rootfs/             # the container filesystem (persistent)
    rootfs/work/        # the project copy, seen as /work inside the sandbox
    rootfs/.moat/entry.sh   # the inner boot script (generated, contains no secret)
    mnt/                # scratch mount point the rootfs is bound onto
    runtime/boot.sh     # the outer boot script, kept for audit
    logs/sandbox.log    # everything the sandbox prints
    snapshots/*.tar.gz  # rootfs snapshots (never the project)
    server-password     # mode 0600, per-boot random, outside the rootfs
```

`/work` lives *inside* the rootfs because that is the only way to get it into the
sandbox without a bind mount. Snapshotting excludes it, snapshots capture the
rootfs (installs, caches), never the project. See §8.

### 2.2 States

```
(absent) --moat up--> provisioning --> running --moat down--> stopped
                                          |                      |
                                          +-------moat up--------+
                                          |
                                     moat destroy --> (absent)
```

`stopped` is a real, useful state: the rootfs and the project copy survive, so
the next `moat up` is a warm boot that preserves everything the agent installed.
`moat destroy` is the only operation that deletes data.

### 2.3 Boot sequence, the exact commands

`moat up` performs, in order:

1. **Host capability probe** (`lib/host.ts:probeHost`). If unprivileged user
   namespaces are unavailable, moat **refuses to run**. There is no host
   fallback, by design: requirement 2 says sandbox is the only mode.
2. **Provision** (first time, or `--fresh`), `sandbox/rootfs.ts`:
   * if a cached image for this `(alpine version, opencode version, package set)`
     exists on the host, extract it and skip the network entirely;
   * otherwise download and extract the Alpine minirootfs on the host (no
     privileges),
   * boot a throwaway sandbox and run `apk add` **inside it** for
     `bash git curl ripgrep libstdc++ ca-certificates coreutils util-linux
     findutils diffutils patch`,
   * extract the pinned `opencode-linux-x64-musl@1.18.31` binary to
     `/usr/local/bin/opencode`,
   * install the bundle to `/usr/local/share/moat/`,
   * write a sandbox-owned git identity to `/root/.gitconfig`,
   * cache the finished image for future environments, and point `baseline` at it.

   The image cache matters because `apk add` is the only networked step and the
   Alpine CDN is intermittently degraded: cold start was measured at 7.9s with a
   healthy mirror and **927s** with a degraded one. The cached artefact contains
   the packages, the binary and the bundle, no credential and no project
   (`./work` is excluded, as for snapshots), so caching it preserves every
   property in §5 and §7.
3. **Copy in** (§3).
4. **Mint a credential** (§5).
5. **Boot** (`sandbox/launcher.ts`) with this namespace set:

```
unshare --user --map-root-user --mount --pid --fork --uts --ipc --kill-child sh <boot.sh>
```

   and this mount table, built by `boot.sh` (generated, and left on disk at
   `envs/<id>/runtime/boot.sh` so it can be read rather than trusted):

```
mount --make-rprivate /
mount --bind  <rootfs> <mnt>              # the root becomes a mount point
mount -t proc proc <mnt>/proc
mount -t tmpfs -o mode=755,nosuid tmpfs <mnt>/dev
mount --bind  /dev/{null,zero,full,random,urandom,tty} <mnt>/dev/*   # read-only device nodes
mount -t devpts -o newinstance,ptmxmode=0666,mode=620 devpts <mnt>/dev/pts
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs <mnt>/dev/shm
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs <mnt>/tmp
mount -t tmpfs -o mode=755,nosuid,nodev tmpfs <mnt>/run
cp /etc/resolv.conf <mnt>/etc/resolv.conf          # a copy, not a mount
exec chroot <mnt> /bin/sh /.moat/entry.sh
```

6. **Serve**: the entry script `cd`s to `/work` and execs
   `opencode serve --port N --hostname 127.0.0.1 --print-logs`, with
   `OPENCODE_CONFIG` pinned to the bundle and `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
7. **Readiness**: the host polls `GET /config` with basic auth until it answers,
   then reports the measured cold start.

Host and sandbox communicate only over HTTP on `127.0.0.1`, because the sandbox
runs the server and the host is a client. **moat proxies nothing**: no
filesystem, no socket, no subprocess.

### 2.4 Commands

| command | effect |
| --- | --- |
| `moat run "<task>"` | `up` when needed, then do the task and stream it. The entry point most people use |
| `moat take [branch]` | fetch the agent's branch, show its commits and diff, and offer to apply it |
| `moat up [task]` | provision if needed, copy in, mint a credential, boot, wait for ready |
| `moat attach` | the interactive session: watch the agent work and steer it. Also what `moat run` opens at a terminal |
| `moat attach --prompt TEXT` | drive one prompt and exit; the scriptable form |
| `moat fetch [branch] [--all]` | `git fetch` the agent's branch from the sandbox into `refs/moat/*` |
| `moat apply <branch> [--checkout]` | turn a fetched ref into a local branch (never automatic) |
| `moat status [--all]` | state, endpoint, credential expiry, snapshots, sandbox branches |
| `moat down` | stop the sandbox, keep the environment |
| `moat destroy` | delete the environment for this project |
| `moat snapshot [name]` / `moat restore <name>` | rootfs snapshots |
| `moat exec -- <cmd>` | run one command in a fresh boot of the environment's sandbox |
| `moat shell` | interactive shell inside the sandbox |
| `moat doctor` | host probe plus 15 isolation assertions executed *inside* the box |
| `moat tools` | the declared bundle, the registry, and the measured gap between them |
| `moat models [provider]` | what the models.dev catalog offers, with real context windows |
| `moat profiles` | toolchain profiles, and the base packages every image has |
| `moat env` | connection details (url, user, password, basic-auth header) |
| `moat logs [sandbox\|audit]` | tail a log |

---

## 3. Copy-in contract

**Requirement: the project is COPIED into the sandbox, never bind-mounted.**

Transport, for a git project: `git clone --no-hardlinks <project> <rootfs>/work`.

* `--no-hardlinks` is not cosmetic. A plain local clone hardlinks object files,
  which would make sandbox files writable aliases of the user's repository.
* Cloning (rather than copying `.git/`) **sanitises git metadata for free**:
  remotes with embedded tokens, credential helpers and hooks do not come along.
  A `cp -a` of the project directory would carry all three.
* Host git is run with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`
  and `GIT_LFS_SKIP_SMUDGE=1` so the result does not depend on the user's git
  configuration (`sync/copyin.ts:SANITIZED_GIT_ENV`).

`git clone` reproduces committed state only, so the **uncommitted working tree is
replayed on top, using git itself**:

* `git diff --binary HEAD` from the host, applied inside the clone. This carries
  modifications, deletions and binaries,
* `git ls-files -o --exclude-standard` for untracked files, copied with their
  modes, symlinks preserved as symlinks.

**Known v0 limitation:** gitignored paths (`node_modules`, `.venv`, `target`, …)
are *not* copied. This is deliberate, the box has its own package manager and
its own network, and the point of the product is a fresh environment. It is
recorded in `test/evidence/up.txt` as the `dirty`/`untracked` counts.

**Non-git directories** fall back to `rsync -a --delete --exclude .git/` (as the
brief specifies), and are then given a fresh repository inside the sandbox
(`sync/copyin.ts:ensureSandboxRepo`) so that the copy-out contract in §4 holds
for every project, not just git ones.

---

## 4. Copy-out contract

**Requirements: explicit, user-initiated, never auto-applied.**

1. The agent commits inside the sandbox, on a branch.
2. `moat fetch [branch]` runs, **on the host**:

   ```
   git -C <project> fetch --no-tags <rootfs>/work +refs/heads/<branch>:refs/moat/<branch>
   ```

   One refspec, forced, no tags. Only the branch the user asked for crosses the
   boundary.
3. `moat apply <branch>` creates the local branch `moat/<branch>`, and only with
   `--checkout` does it touch the working tree, and then only if the tree is
   clean.

Uncommitted work in the sandbox is in no ref, so no fetch can reach it. `moat
fetch` reports it and names the files; `moat fetch --commit-worktree` commits it
in the sandbox first, then fetches. Nothing commits to a sandbox branch unless
the user asks. The same rule guards the automatic re-copy described in §2.2: if
the host project has changed but the sandbox holds commits or files the host
cannot reach, moat warns rather than overwriting them.

Guarantees, both verified in `docs/VERIFICATION.md`:

* **The working tree is never modified.** `moat fetch` adds objects and one ref
  under `refs/moat/`. It does not move `HEAD`, does not touch the index, and does
  not touch a single tracked file. The verification recomputes a full tree hash
  (paths + modes + symlink targets + content) before and after `moat fetch` and
  requires the digests to match.
* **Nothing is applied automatically.** After `moat fetch`, the user's checkout
  is exactly as it was; the agent's work is visible at `refs/moat/<branch>`.

A note on the transport: the sandbox's repository is a directory on the host's
filesystem (`envs/<id>/rootfs/work`), so the host can name it as a git remote.
That is still a plain `git fetch` from the sandbox's repository, with no mount
involved. Serving it over a socket inside the sandbox instead is a v1 hardening
item, see `docs/UPSTREAM-CANDIDATES.md`.

---

## 5. Credential axiom

**Requirements: inject one scoped, short-lived credential at boot. Never bake
keys into the image. Never forward host env, SSH agent, or dotfiles.**

### 5.1 Where it comes from

`secrets/broker.ts`, in precedence order:

1. `--credential` (literal; discouraged, because it lands in shell history),
2. `--credential-env NAME`, reads one named variable from the host,
3. `~/.moat/credentials.json` (mode must be `0600`; moat refuses to read a
   group- or world-accessible credentials file),
4. convention: **only moat-specific names**, `MOAT_CREDENTIAL` and
   `MOAT_MOCK_CREDENTIAL`.

**moat will not silently use `OPENAI_API_KEY` (or any other general-purpose
provider key) from your environment.** It says the key is there, explains that
the agent can read and exfiltrate whatever it is given, and tells you to pass
`--credential-env NAME` if you really mean it. That is one word of friction in
exchange for a conscious decision, which is the right trade for a tool that runs
with no permission prompts and an open network, see §1.3.

The provider endpoint and model come from `--provider-base-url` / `--model` or
from the store entry. v0's bundle speaks the **OpenAI-compatible** protocol, so
any compatible endpoint works (OpenAI, DeepSeek, Groq, OpenRouter, Ollama,
llama.cpp, LiteLLM). An Anthropic-native provider block is a small, additive
change (see `docs/UPSTREAM-CANDIDATES.md`).

### 5.2 How it enters

The value is passed as an environment variable to the sandbox's main process.
That is the only channel, and it is deliberately weak, see §1.2: a process that
must use a credential cannot hide it from code running as the same uid. The
design goal is not to conceal the key but to make the key **disposable**.
Concretely:

* The bundle config references `{env:MOAT_INJECTED_CREDENTIAL}`. opencode
  substitutes `{env:VAR}` from the environment at config-load time
  (`packages/opencode/src/config/variable.ts`). **The value is never written to
  disk**, the image contains the reference, not the secret. Verification greps
  the entire rootfs for the credential value and requires zero matches.
* The generated entry script (`rootfs/.moat/entry.sh`) contains only
  `$MOAT_INJECTED_CREDENTIAL`, a shell variable reference.
* `state.json` records `sha256:…` of the credential (16 hex chars), never the
  value. That is enough to correlate, useless to an attacker.
* The credential is **not** included in rootfs snapshots, because it is never in
  the rootfs.
* Shell commands the agent writes do not inherit the value: the bundle's
  `shell.env` hook overrides every secret-looking variable to the empty string.
  This is a speed bump, not a boundary, `shell.env` is merged *onto* opencode's
  process environment (`{ ...process.env, ...extra.env }`,
  `packages/opencode/src/tool/shell.ts:422`), so a variable can only be
  overridden, never removed, and `/proc/<pid>/environ` still holds the real
  value.

### 5.3 How it expires

Every mint records `expiresAt = now + ttl` (default `4h`, `--credential-ttl`).
The sandbox receives the TTL and runs a watchdog: when it elapses, the entry
script's background timer stops the agent process. The next `moat up` mints a
fresh credential; an expired one is never reused. `moat status` shows the
remaining seconds.

One limitation: v0 enforces the TTL by *terminating the agent*, not by
revoking the token at the provider. Provider-side scoping and revocation, plus
short-lived STS-style tokens, are v2 work ("credential brokering with expiry").
What v0 does do is make the credential exist for one boot, in memory only, with
a recorded expiry, over a name (`OPENCODE_SERVER_PASSWORD`, `MOAT_*`) allowlist.

### 5.4 What is never forwarded

`sandbox/launcher.ts:sandboxEnv()` builds the sandbox environment from an
explicit literal. There is no spread of `process.env`. The only names that
cross are `PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM`, `MOAT_SANDBOX`, the injected
credential variables, and `OPENCODE_SERVER_PASSWORD`.

`moat doctor` verifies this from *inside* the box by listing the sandbox's
environment and comparing it against the host's, requiring that no host variable
name (and specifically no `*KEY*`, `*TOKEN*`, `*SECRET*`, `*SSH*`, `*AWS*` name)
appears. It also checks that the host's `$HOME` and `$HOME/.ssh` are not
reachable, and that a canary file which exists only on the host (`~/.moat/canary`,
mode 0600) cannot be read.

There is one deliberate escape hatch: `MOAT_SANDBOX_ENV` adds extra variables to
the sandbox, and it **rejects any name that does not start with `OPENCODE_` or
`MOAT_`**. It exists because `OPENCODE_CLIENT` is load-bearing for the bundle
(§6) and because debugging a sandbox otherwise means editing source.

---

## 6. The tool bundle

**Requirement: the tool set is curated and bundled, the user gets exactly the
tools the bundle declares, not opencode's defaults.**

### 6.1 What the bundle is

The config is **rendered per boot** from `bundle/render.ts`, together with
`bundle/plugin/moat-bundle.mjs` and the agent brief. All of it is installed to
`/usr/local/share/moat/` (and `/root/.config/opencode/AGENTS.md`) on every boot,
never baked into an image, a cached image serving a stale policy is a bug that
already happened once. It declares:

* `permission: {"*": "allow"}`, the only rule, and it allows. No approval prompt
  can fire and no denial can be tripped.
* `tools: {webfetch: false, websearch: false, question: false, skill: false,
  task: false}`, the excluded set.
* a single OpenAI-compatible provider (`moat`) whose `apiKey` is
  `{env:MOAT_INJECTED_CREDENTIAL}`, see §5.2.
* `share: "disabled"`, `autoupdate: false`.
* pinned config resolution: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`,
  `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_CLIENT=moat`.

**Curated set (what the bundle grants):**
`read`, `write`, `edit`, `apply_patch`, `glob`, `grep`, `bash`, `todowrite`.

**Excluded (opencode built-ins that are not in the bundle):**
`webfetch`, `websearch`, `question`, `skill`, `task`.

Profiles are detected from the project when `--profile` is not given:
`package.json` means node, `pyproject.toml`/`requirements.txt` python, `go.mod` go,
`Cargo.toml` rust, a JVM build file java, a `Makefile`/`CMakeLists.txt` a C
toolchain. A wrong guess costs a long package install, so detection is
conservative: it adds a profile only when the project plainly asks for one, says
what it detected and why, and `--no-detect` turns it off.

`--tools extended` swaps in a wider set (`+ webfetch, + task`). Neither changes
the security posture, `bash` and `curl` already reach the network, but both
widen what the model can reach for, so they are opt-in. `--tools core` is the
default.
(Full built-in list, verified in
`packages/core/src/tool/builtins.ts`: `apply_patch, bash, edit, glob, grep,
question, read, skill, todowrite, webfetch, websearch, write`.)

### 6.2 What the plugin does

`bundle/plugin/moat-bundle.mjs` runs inside the sandbox, imported by opencode. It
is plain ESM JavaScript on purpose: the rootfs ships no build toolchain.

1. **Curation, enforced at the tool boundary.** `tool.execute.before` throws for
   any tool id outside the curated set and records the attempt in the audit log.
   This is what makes "the user gets exactly the tools the bundle declares" true
   *in behaviour*.
2. **Confinement of mutations.** `write`, `edit` and `apply_patch` are pinned to
   the workspace and `/tmp`. This stops the agent from scribbling on its own
   rootfs (`/usr`, `/etc`) and poisoning the persistent snapshot. It is defence
   in depth: the real boundary is the mount table, and a write outside the
   workspace would only damage the disposable box.

   Reads are deliberately *not* confined: the box contains nothing sensitive, and
   an agent legitimately reads `/etc/os-release`, `/proc/cpuinfo` and similar.

   The argument names are the **model-facing** ones, verified by reading the
   running server's schemas with `GET /experimental/tool`: opencode's internal
   schemas declare `path`
   (`packages/core/src/tool/{read,write,edit}.ts`) but the provider-facing schema
   renames it to `filePath` for read/write/edit. Checking the wrong spelling here
   fails silently and confines nothing, so the guard accepts both. `docs/VERIFICATION.md`
   records the full argument-name table.
3. **Audit.** Every tool call is appended to an append-only JSONL log at
   `/var/log/moat/tools.jsonl`, with the injected credential redacted.
4. **Permission accounting.** A `permission.ask` hook records and allows. With
   `permission: {"*": "allow"}` it never fires; the verification asserts that the
   log file does not exist, i.e. **zero permission requests were raised**.
5. **Config assertion.** At load it fails loudly if the expected `tools`
   omissions are not present in the effective config, so a future opencode
   change surfaces immediately instead of silently shipping more tools.

For the record, the hook name is `permission.ask`, not `permission.asked`, the
brief's spelling does not exist in `packages/plugin/src/index.ts`.

### 6.3 Where requirement 4 is not fully achievable, and what moat does instead

**This is the one requirement that cannot be met as literally stated without
changing opencode, and moat does not pretend otherwise.**

opencode 1.18.31 has no supported way to remove a built-in tool from the list it
advertises to the model. The evidence:

* The model-facing list is built from the static `builtin` array in
  `packages/opencode/src/tool/registry.ts` (~line 231), returned by `all()` as
  `[...builtin, ...custom]` (~line 261) and consumed by
  `packages/opencode/src/session/tools.ts:92`, with **no permission filter
  applied to built-ins**.
* Permission-based hiding exists, but is only applied to MCP tools:
  `Permission.visibleTools(...)` at `packages/opencode/src/tool/registry.ts:286`.
* `tools: {x: false}` in config compiles to a *permission rule*
  (`tools: {x: false}` → `permission.x = "deny"`, see
  `packages/opencode/src/config/config.ts:567` and
  `packages/core/src/v1/config/agent.ts`), not to list pruning.

Measured consequence, the tool list the provider actually receives for a
non-GPT model, captured from the inference request (`docs/VERIFICATION.md`):

```
['bash', 'edit', 'glob', 'grep', 'read', 'skill', 'task', 'todowrite', 'webfetch', 'write']
```

Against the bundle's curated set of
`read, write, edit, apply_patch, glob, grep, bash, todowrite`. That is:

* **absent as intended**: `websearch` (opencode gates it on the provider, 
  `webSearchEnabled`, our provider is not `opencode`), `question` (gated on
  `RuntimeFlags.client`; moat sets `OPENCODE_CLIENT=moat`, which removes it),
  and `apply_patch` (opencode offers it only for `gpt-*` models, 
  `registry.ts`, `usePatch`).
* **still advertised, but refused at execution**: `skill`, `task`, `webfetch`.
  The bundle's plugin rejects them, and the refusal is recorded in the audit log.

So: moat's bundle *is* the complete set of tools that can do anything, and
`moat tools` prints the gap rather than hiding it. Closing the gap properly needs
an upstream hook; the proposed change, with the exact locations and a diff-size
estimate, is in `docs/UPSTREAM-CANDIDATES.md`. v0 does not fork or
patch opencode.

---

## 6b. The harness

Everything in this section exists because the agent has to be able to work
unsupervised on real projects, with real dependencies, against real providers, 
and because a harness that is merely *configured* is not the same as one that
*works*.

### 6b.1 Provider resolution, and why there is no provider block

opencode is built on the [models.dev](https://models.dev) catalog: 222 providers
with maintained base URLs, npm SDK packages, context windows, output limits and
tool-call support. That dataset is not worth reimplementing. Guess a context
window wrong and opencode compacts at the wrong moment, and the failure looks like
a model problem.

So for a provider the catalog defines (`zai`, `deepseek`, `openai`, `anthropic`,
`openrouter`, `groq`, `moonshot`):

* moat writes **no provider block at all**;
* it injects the credential under the variable name opencode expects
  (`ZHIPU_API_KEY`, `DEEPSEEK_API_KEY`, …);
* it sets `model` to `<provider>/<model>` and `enabled_providers` to that one
  provider, so opencode's surface is exactly what you configured.

moat declares a provider itself only when it must, a custom OpenAI-compatible
endpoint (`--provider local --provider-base-url …`, which covers Ollama,
llama.cpp, vLLM, LiteLLM, LM Studio), and then it states the context and output
limits explicitly rather than guessing generously.

The catalog is cached on the host for a day and is optional: without it moat falls
back to its own provider table and says so. `moat models` reads it live, and
`moat up` warns when a requested model id is not in it, instead of letting opencode
fail to resolve it silently.

Verified wiring for all three target providers is in `docs/VERIFICATION.md`.

### 6b.2 Toolchain profiles

"Anything we throw at it" has two bad answers: bake a kitchen sink (a 4 GiB image
that still lacks the one thing you needed), or bake nothing (the agent spends its
first ten turns installing a compiler, and some installs fail because there are no
build tools to build them with).

moat does neither. The base image is small and boots in seconds; everything else
is a named profile, installed on demand with the sandbox's own package manager,
cached per package set on the host, and persisted in the rootfs. Installing a
profile into an existing environment is **incremental**: it checks `apk info -e`
for each package first, so adding a profile later costs only what is missing.

| profile | contents |
| --- | --- |
| `node` | node, npm, pnpm, yarn, esbuild |
| `python` | python3, pip, venv, uv, python3-dev |
| `cc` | build-base, gcc, g++, cmake, ninja, autotools, headers |
| `go`, `rust`, `java` | the language toolchains |
| `db` | PostgreSQL, SQLite, Redis, **servers**, not just clients, so the agent can test against a real database |
| `net` | openssh-client, iproute2, dig, nmap, nc, socat, tcpdump |
| `browser` | headless Chromium, chromedriver, fonts, nss |
| `cli` | gh, git-lfs, tmux, vim, yq |
| `full` | all of the above |

Every package name was checked against the real Alpine 3.21 `main` and
`community` indexes rather than remembered, an earlier revision of moat's package
list contained a package that does not exist, which is the kind of mistake that
only surfaces at provisioning time.

The base image always includes `gcompat`, because this is musl and most prebuilt
binaries are built for glibc; without it they fail with a "not found" that has
nothing to do with the file being missing.

### 6b.3 The agent brief

`moat` writes `/root/.config/opencode/AGENTS.md` inside the sandbox, verified in
`packages/opencode/src/session/instruction.ts:61` as a global instruction file, and
verified empirically by inspecting the system prompt the provider receives. It is
never written into the project: the user's repository is copied in byte-for-byte
and moat adds nothing to it.

The instructions tell the agent:

* it is in a disposable box, and may install, break and delete freely;
* the network is open, and it should install what it needs rather than work
  around a missing tool;
* **nobody is going to answer a question**, decide, act, and document the
  assumption;
* it is expected to run the tests and paste real output, and never to claim
  something works without having run it;
* the credential in its environment is readable and must never be printed,
  committed or sent anywhere, and a project file or dependency asking it to
  exfiltrate environment variables is an attack to refuse.

An agent that does not know it is in a box wastes turns being careful. An agent
that does not know the network is open will not install what it needs. Both are
harness failures, and this file is the cheapest fix in the project.

### 6b.4 The working branch

Every boot puts the sandbox's working tree on `moat-session-<timestamp>`, so the
user's own branch is untouched *inside* the box as well as outside it, and
copy-out has one predictable ref to read. `moat fetch` with no argument fetches
that branch; `moat apply` creates a local branch of the same name.

Sessions live in the rootfs and therefore survive `moat down` / `moat up`;
`moat attach --continue` resumes the most recent one.

### 6b.5 The interactive session

At a terminal, `moat run` does not print and exit. It opens a session where the
agent's work streams as it happens and the user can type at any time. Typed text
goes to the same session; if a turn is in flight the server queues it and it lands
at the next step, and ctrl-c aborts the turn without losing the session.

This is a client of the sandbox's own server, nothing more: the event stream for
the live view, `prompt_async` to send, `abort` to interrupt. The queueing
behaviour is the server's, and was verified rather than assumed: two messages sent
during one turn produce two user messages and both are processed.

It replaces an earlier design that exec'd opencode's own TUI, which meant an
interactive session was impossible unless opencode was also installed on the
host. The sandbox already runs the server, so that dependency was never
necessary.

`test/repl-smoke.py` drives the CLI through a real pty and asserts on what comes
back. Piping stdin is not a substitute: readline behaves differently without a
terminal, and the live view is the whole point of the mode.

---

## 7. Isolation model

### 7.1 What v0 isolates

| dimension | mechanism | verified by |
| --- | --- | --- |
| user | `unshare --user --map-root-user` (uid 0 inside is the calling user outside) | `uid_map` assertion in `moat doctor` |
| mount | `unshare --mount`, root replaced by `chroot` into a mount the sandbox owns | namespace inode differs from the host's; mount table has no host path |
| PID | `unshare --pid --fork` | PID 1 is the sandbox's own `sh`; ≤ 12 visible processes |
| UTS / IPC | `unshare --uts --ipc` | namespace inodes differ from the host's |
| filesystem | the root is the Alpine rootfs; the host's `/` is unreachable | host project path and `$HOME` are absent inside |
| credentials | one injected variable; no host env, no SSH agent, no dotfiles | canary + env-name diff |

The sandbox is also unable to create device nodes (`mknod` is refused in an
unprivileged user namespace, verified EPERM), which is why §7.2 exists.

### 7.2 The one host mount, stated plainly

`/dev` is a fresh tmpfs. Six **device nodes** (`null`, `zero`, `full`, `random`,
`urandom`, `tty`) are bind-mounted into it read-only from the host, because
`mknod` cannot create them from nothing in a user namespace and a userspace
process needs `/dev/null` to exist. This is what every rootless container runtime
does. They carry no host data.

An acceptance criterion was that `mount` should show *no* host bind-mounts.
Taken literally that is impossible on this host. The nearest true statement,
which `moat doctor` prints in full, is: **the mount table contains no host
filesystem path; the only host-originated mounts are six read-only device
nodes.** `docs/VERIFICATION.md` quotes the complete 13-line mount table so the
claim can be checked line by line.

### 7.3 Network: the significant v0 limitation

**The sandbox shares the host's network namespace.** This is measured and
printed by `moat doctor`, not glossed over. Consequences:

* The agent has the host's network position and unrestricted egress. Network
  egress policy is v2 work.
* The agent can reach services listening on the host's loopback, including the
  sandbox's own `opencode serve` (protected by a per-boot random password) and
  anything else the user happens to be running locally.

Why it is not fixed in v0: giving the sandbox its own network namespace leaves it
with only loopback, which would cut off the provider. That is moat's whole purpose. A
veth pair plus NAT requires `CAP_NET_ADMIN` in the host namespace; `slirp4netns`
or `passt` would work but neither is installed, and `newuidmap`/`newgidmap` are
absent so `/etc/subuid` cannot even be used. This host has no `podman`/`docker`
and no `sudo`. Within those constraints, "sandbox the filesystem and credentials,
share the network" is the best available; the fix is v1's microVM, where the
network boundary comes for free.

### 7.4 Exposures, as `moat doctor` reports them

`moat doctor` separates three kinds of finding, and the distinction is the point:

* **`check`**, a property that must hold. A failure fails the run and exits non-zero.
* **`note`**, measured context that is neither good nor bad, e.g. a deliberate
  limitation.
* **`exposure`**, a measured weakness that v0 does not fix. It must not fail the
  run, because it is a design choice rather than a bug; but it must be impossible
  to miss.

The `exposure` kind exists so that a weakness cannot render as `pass`. A test
that reports `pass` for a sandbox whose bash tool can read the injected credential
is worse than the weakness itself. The
three fixed exposures are listed in §1.2, and the live output is transcribed in
`docs/VERIFICATION.md`.

### 7.5 Why not a container runtime

`podman` and `docker` are not installed and cannot be installed (no `sudo`, no
`newuidmap`). Rather than degrade to running the agent on the host, which
requirement 2 forbids, moat builds the isolation directly from
`unshare`/`mount`/`chroot`, which are present and work. That is also why the
launcher is ~200 readable lines instead of a runtime dependency.

---

## 8. Persistence and snapshots

**Requirement: environments persist per project, with rootfs snapshots, so
installs and caches survive between sessions. Snapshot the rootfs, not the
project.**

* The rootfs is reused across boots. `moat down` stops the process; the next
  `moat up` reuses everything, including packages the agent installed.
  Verified: install a package with `moat exec`, `moat down`, `moat up`, and the
  package is still there (`docs/VERIFICATION.md` §persistence).
* `moat snapshot [name]` writes `snapshots/<name>.tar.gz`, a tar of the rootfs
  with `./work`, `./proc`, `./sys`, `./dev`, `./tmp`, `./run` and `./.moat`
  excluded. **The project is in none of them**; the exclusion list is explicit in
  `sandbox/rootfs.ts:SNAPSHOT_EXCLUDES`.
* `moat restore <name>` replaces the rootfs but stashes and restores `/work`, so
  restoring an old image never destroys the agent's work.
* `baseline` always exists right after provisioning. When the environment came
  from the cached image, `baseline.tar.gz` is a **symlink** to that image rather
  than a second 107 MiB compression, the cache file *is* the baseline.
* `moat restore` refuses to run against a live sandbox unless `--yes` is passed,
  because replacing the rootfs underneath a running box would leave it serving a
  deleted image. The check is in `cmd/main.ts:cmdRestore`.

`moat up --sync` re-copies the project from the host, discarding the sandbox's
working tree; it warns with the count of commits that exist only inside the
sandbox before doing so.

---

## 9. Failure modes

| failure | behaviour |
| --- | --- |
| no user namespaces | `moat up` refuses; prints the reason and, on WSL, the fix |
| bundle config cannot be parsed | opencode fails at load; the sandbox log is printed |
| the plugin's curation assertion fails | the plugin throws at config load, surfacing at boot |
| `opencode serve` does not become ready | `moat up` prints the last 40 lines of the sandbox log and kills the sandbox |
| the recorded PID is stale | `moat up`/`status` reconcile against the live process table |
| credential TTL elapses | the in-sandbox watchdog stops the agent; the box stays up |
| Alpine CDN returns a transient index error | provisioning rotates four mirrors and retries; success is decided by `apk info -e`, not by apk's exit code |

---

## 10. Deliberately absent

* **No Windows path, no host path.** There is no flag that runs the agent
  outside the sandbox.
* **No custom TUI.** `moat attach` (interactive) execs opencode's own `attach`
  client. moat ships no UI of its own in v0.
* **No opencode fork, patch or vendored copy.** opencode is a pinned dependency
  (`opencode-ai@1.18.31`).
* **No proxying of tools.** The agent loop, the tools and the filesystem live
  inside the box; the host is only a client.
* **No `rsync` for git projects.** It cannot represent deletes, renames and
  symlinks as faithfully as git, so it is only the non-git fallback.
* **No secrets in the image, ever.** Enforced by a check in
  `bundle/install.ts` that refuses to install a bundle containing something that
  looks like a literal API key.
