# moat, specification (v0)

moat runs an AI coding agent inside a disposable, fully isolated Linux box. The
host is never touched: not by a bind mount, not by an environment variable, not
by a forwarded credential, not by the agent's writes.

This document is the contract. It describes what v0 does, and it is explicit
about where v0 falls short of the design goals, with the evidence for each.

---

## 1. What the sandbox does and does not protect

The sandbox protects the host. It does not protect the project, and it does not
protect the credential: the agent has to read the project to work on it, and has
to read the key to call the model. Both are therefore available to it, and with
egress policy decides who else can get them, and by default the box may reach
the provider and the package registries and nothing else. That narrows the
audience; it does not make either one confidential. This section states which is
which, so neither claim is read as covering the other.

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

The host never writes outside the box on the agent's behalf either. The rootfs is
persistent and the agent is root inside it, so it can replace one of its own
directories with a symlink to a host path; moat's host-side writes resolve through
`lib/rootfs-fs.ts`, which refuses to follow one (measured in
`docs/VERIFICATION.md` §M).

### 1.2 What the sandbox does NOT protect

Measured, not assumed (`moat doctor` prints all three on every run):

* **The credential.** It is in the agent's process environment. The bundle blanks
  secret-looking variables for shell commands the agent writes, but the value
  remains in the opencode process environment and any process running as the same
  uid can read it from `/proc/<pid>/environ`. **You cannot hide a credential from
  a process that must use it, running as the same uid inside the box.** Every
  in-sandbox mitigation is a speed bump.
* **The project's confidentiality.** The agent can read every byte of the copy,
  and egress is an allowlist rather than a wall, so anything on that allowlist —
  or DNS — can carry them out.
* **Your host's loopback.** In the default `filtered` mode, and in `isolated`,
  the sandbox has its own network namespace and the host's loopback is closed on
  both routes (§7.3), so the services you run locally are out of reach. Only
  `moat up --egress open` puts the sandbox back in the host's namespace, and
  then every service on the host's loopback is reachable from inside.

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
2. **Egress policy.** Restricting where the box can talk is the main thing that
   limits exfiltration, and it is what a new environment gets by default: its own
   network namespace behind an nftables default-deny allowlist built from the
   provider and the package registries (§7.3). The remaining hole is the
   allowlist itself: an allowlisted host, or DNS, can still carry data out.
3. **Choosing not to put things in the box.** `moat up` names any copied-in file
   that looks like it holds a credential.

**In one line:** moat is a containment boundary for your *host*, not a
confidentiality boundary for your *project* or your *credential*. The default
egress policy narrows who the box can talk to; it does not make either secret. If
you need that, use `moat up --no-credential` and drive the agent with something
you do not mind losing — including a local OpenAI-compatible endpoint, which then receives
no `Authorization` header from the box at all.

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
    logs/sandbox.log    # the host side of the boot, before the box takes over
    rootfs/var/log/moat/boot.log  # everything the sandbox prints; inside its own rootfs,
                                  # so the running box holds no fd on a host file
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
`moat destroy` is the only command that deletes an environment; `moat up --fresh`
replaces the rootfs instead, and is gated twice for exactly that reason (§2.3).

`state.json` is metadata, not the environment: the rootfs is. If it is missing or
unreadable while `rootfs/work` is still there, `moat up` rebuilds it from the disk
(`sandbox/recover.ts`): the branch and the copy-in baseline from the sandbox
repository, the Alpine version from the rootfs. What cannot be derived is not
invented — a new credential is minted, and with no recorded host baseline the drift
check reports that it cannot run rather than comparing against a guess. An
unreadable state file is kept beside the new one as `state.json.corrupt-<time>`.

While a boot is running, the environment is in the `provisioning` state of the
diagram above: `state.json` still describes the state *before* it, so `moat status`
reports `booting (pid N, Ns in)` rather than `stopped`, and `moat down`, `moat
destroy`, `moat restore` and a second `moat up` wait for that boot to finish rather
than acting on the stale file. The marker is a pid *and* its start time
(`sandbox/boot.ts`), so a boot that was interrupted leaves nothing to wait for. Only
the long-running boot takes it: ephemeral boots (`moat exec`, `moat doctor`,
`moat shell`, the checks runner) are meant to run alongside it.

A sandbox in an own-namespace mode also has a **datapath process** (`slirp4netns`), and
that process outlives the box if the box dies out of band — a `kill -9`, an OOM kill, a
host reboot. `moat down`, `moat destroy`, `moat restore` and the restart inside
`moat up` stop it after the box, and a boot that is about to start a **new** box reaps a
recorded datapath whose box is no longer alive: booting overwrites `state.json`, and a
process nobody records can never be attributed again. Measured before that: one
`kill -9`, then `moat up` left two `slirp4netns` processes, and `moat destroy`
reclaimed only the new one. A recorded pid is signalled only while its `/proc` start time
still matches the record.

### 2.3 Boot sequence, the exact commands

`moat up` performs, in order:

1. **Host capability probe** (`lib/host.ts:probeHost`). If unprivileged user
   namespaces are unavailable, moat **refuses to run**. There is no host
   fallback, by design: requirement 2 says sandbox is the only mode.
2. **Provision** (first time, or `--fresh`), `sandbox/rootfs.ts`:
   * the Alpine minirootfs and the pinned opencode tarball are checked against
     the digests published for those exact versions (`lib/pins.ts`: the release
     directory's SHA-256 and npm's `dist.integrity`). A mismatch, including one
     in an already-cached file, is re-downloaded rather than unpacked. Cache
     writes go to a per-call temp file and are renamed into place, so two moat
     processes cannot interleave into one `.part`;
   * if a cached image for this `(alpine version, opencode version, package set)`
     exists on the host, extract it and skip the network entirely (the image cache
     carries a `.sha256` sidecar written when it was built, and a mismatch
     rebuilds it);
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
mount --bind  /dev/{null,zero,full,random,urandom,tty} <mnt>/dev/*   # device nodes (rw)
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
| `moat` | open a session in the current directory. The entry point |
| `moat run "<task>"` | the same, non-interactively, for scripts |
| `moat verify` | run the project's own checks against the sandbox, no model involved |
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
| `moat doctor` | host probe plus the in-box isolation checks for the egress mode in force — `open`, `isolated` and `filtered` each run a different set, and the command prints the count it ran |
| `moat tools` | the declared bundle, the registry, and the measured gap between them |
| `moat models` | DeepSeek models and their context windows, from the catalog |
| `moat profiles` | toolchain profiles, and the base packages every image has |
| `moat env` | connection details (url, user, password, basic-auth header) |
| `moat logs [sandbox\|audit]` | tail a log |

Flags are per command. The parser knows every flag moat has, so a typo is an error,
and each command declares the ones it reads: a flag the command does not read is
refused before it runs rather than accepted and ignored. `--help`, `--quiet` and
`--verbose` apply everywhere, and `moat <command> --help` prints the command list
instead of running the command.

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

File names are addressed as text. A name that is not valid UTF-8 (a raw byte such
as 0xff) cannot be read back reliably by the host-side walks — Node decodes it to
U+FFFD, which is not the name on disk, so the next lstat reports ENOENT for a file
that is plainly there. moat up refuses such a project before anything is cloned,
naming the bytes. Full support would mean byte paths through every one of those
walks (hashing, the untracked-file pass, apply's tree reads); it does not exist yet.

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

Git cannot carry two more things: an untracked **empty directory** and an
untracked **special file** (FIFO, socket, device). They used to be dropped in
silence, so the sandbox differed from the host with nothing saying so. They are
now named on every copy-in and in `moat up --json` as `skippedFromCopy`;
ignored paths are not listed, because not copying those is the contract above.
`rsync` (the non-git fallback) copies both.

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
3. `moat apply` merges the agent's work into the user's directory. It is a
   three-way merge against `refs/moat/baseline`, the commit moat recorded at
   copy-in holding exactly what was copied, so a file the user changed is never
   overwritten by a file the agent changed. Overlapping edits leave the user's
   file untouched and are reported. `--dry-run` plans without writing.

This makes copy-out work for **any** directory, which the git-only version could
not: a plain directory has no repository for `git fetch` to write into. The
baseline commit is what supplies the missing third input, and it is recorded with
a temporary index so neither the working tree nor the index is disturbed.
`moat fetch` still needs a git repository *on the host*, because it writes a ref
there; in a non-git directory it says so and points at `moat apply`, which merges
the sandbox's tree without one.

Uncommitted work in the sandbox is in no ref, so no fetch can reach it. `moat
fetch` reports it and names the files; `moat fetch --commit-worktree` commits it
in the sandbox first, then fetches. Nothing commits to a sandbox branch unless
the user asks. The same rule guards the automatic re-copy described in §2.2: if
the host project has changed but the sandbox holds commits or files the host
cannot reach, moat warns rather than overwriting them. **Every ref in the box counts,
not just the one checked out** — every branch and tag tip *and* the commit HEAD points
at: each tip is asked whether the host has its objects, and the
unreachable-from-any-host-ref commits under all of them are added up; a host that is
not a repository at all (a plain directory) counts every commit the agent added. A
commit on a branch nobody is standing on is still work, and a re-copy replaces the
whole working tree — measured, a HEAD-only version of this count let the re-copy
destroy a branch, its commit and its file while the warning said the sandbox held
nothing, and a later version that took branches and tags but not HEAD did the same to a
commit made on a detached HEAD. When HEAD is detached the warning says so, because
`moat fetch` reads branches: it names the two commands that keep the work
(`moat exec -- git -C /work branch keep`, then `moat fetch keep`).

Guarantees, both verified in `docs/VERIFICATION.md`:

* **The working tree is never modified.** `moat fetch` adds objects and one ref
  under `refs/moat/`. It does not move `HEAD`, does not touch the index, and does
  not touch a single tracked file. The verification recomputes a full tree hash
  (paths + modes + symlink targets + content) before and after `moat fetch` and
  requires the digests to match.
* **Nothing is applied automatically.** After `moat fetch`, the user's checkout
  is exactly as it was; the agent's work is visible at `refs/moat/<branch>`.

**Copy-out names the credential it carries.** The agent has to read the injected
credential to call the model, so it can also write it into the project; the brief's
instruction not to is advice, not a control. Both copy-out paths therefore compare
what they are about to hand over against the credential values the host can see at
that moment — the environment names moat itself reads (`DEEPSEEK_API_KEY`,
`MOAT_CREDENTIAL`) and the credential store — and print the paths that match:

* `moat fetch` searches the commits the fetch brought in, not only the tip, so a key
  committed and later deleted is still named. By then the objects are in the host
  repository's `.git`; the warning is what says which ref must not be pushed and
  which key to rotate.
* `moat apply` searches the content it is about to write, before writing it, and names
  the files in the plan.

It is a warning, not a gate: the user asked for the work and still gets it, because a
half-apply would be worse than a named exposure. What it does **not** cover, stated so
that silence is not read as approval: a credential rotated between the boot and the
copy-out (the sandbox holds only a fingerprint, by design), a secret the agent found
somewhere other than its own environment, commits older than the most recent 50 in the
fetched branch, and — for `apply` — a file larger than the scan limit. Every one of
those bounds is named when it is reached. A file that does not match is not a claim
that it is clean.

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
4. `DEEPSEEK_API_KEY`, or `MOAT_CREDENTIAL` as an override.

At a terminal, if none of those is present, moat asks for the key rather than
explaining that one is missing: the input is hidden, the key is checked against
the provider before it is saved, and it is written to `~/.moat/credentials.json`
with mode 0600. A key that cannot be checked because the network is down is saved
with a warning rather than refused, because a working key is not made invalid by
a bad connection.

**moat will not silently use `OPENAI_API_KEY` (or any other general-purpose
provider key) from your environment.** It says the key is there, explains that
the agent can read and exfiltrate whatever it is given, and tells you to pass
`--credential-env NAME` if you really mean it. That is one word of friction in
exchange for a conscious decision, which is the right trade for a tool that runs
with no permission prompts and an open network, see §1.3.

The endpoint and model come from `--base-url` / `--model`, or from the store
entry. moat targets DeepSeek and nothing else: for DeepSeek it writes no provider
block at all and lets opencode's models.dev catalog supply the base URL, context
window and capabilities. There is no provider registry, no `--provider` flag and
no inference of a provider from the environment.

`--base-url` still points the bundle at **any OpenAI-compatible endpoint**
(Ollama, llama.cpp, LiteLLM, a gateway), which is how the test suite runs against
a local stub. It is an escape hatch rather than a provider system: moat then has
to describe the model's limits itself instead of reading them from the catalog.
`--upstream` is the narrower flag — same catalog definition, different address —
for a DeepSeek-compatible gateway or a proxy you want to watch.

The **provider configuration** — the base URL and the model id — travels the same
channel but is not part of the credential: it is set whether or not one was injected. So
`moat up --no-credential --base-url http://localhost:11434/v1` boots a box that can call
that endpoint with **no `Authorization` header at all**, which is the mode §1.3
recommends for a local model: nothing stealable in the box. A request to an endpoint that
*does* require a key fails at the endpoint (401), not at moat, and the boot says which case
applies. Measured before this was true: the base URL and model were only ever set as part
of the credential, so a `--no-credential` box had an empty base URL and every model call
died inside it with `ERR_INVALID_URL`, silently.

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
The box receives that timestamp (`MOAT_CREDENTIAL_EXPIRES_EPOCH`) as well as the
TTL, and the entry script computes how long is left **before** it starts the agent:
a credential that is already dead stops the boot instead of producing an agent
whose every model call can only fail, and a live one is stopped on time by a
background watchdog. Counting the TTL from the script's own start, as v0 did at
first, let the box outlive its key by however long the boot took. The TTL remains
the fallback for an environment whose state predates the epoch variable. The next
`moat up` mints a fresh credential; an expired one is never reused. `moat status`
shows the remaining seconds.

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
* `tools: {webfetch: false, websearch: false, skill: false, task: false}`,
  the excluded set. (`question` is curated, not excluded: opencode gates it on
  `OPENCODE_CLIENT`, the bundle turns it back on, and §6b.7 explains why it is
  always advertised rather than hidden.)
* a single OpenAI-compatible provider (`moat`) whose `apiKey` is
  `{env:MOAT_INJECTED_CREDENTIAL}`, see §5.2.
* `share: "disabled"`, `autoupdate: false`.
* pinned config resolution: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`,
  `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_CLIENT=moat`.

**Curated set (what the bundle grants):**
`read`, `write`, `edit`, `apply_patch`, `glob`, `grep`, `bash`,
`todowrite`, `question`.

**Excluded (opencode built-ins that are not in the bundle):**
`webfetch`, `websearch`, `skill`, `task`.

The list lives in one place, `lib/pins.ts`; the renderer, the plugin and
`moat tools` all read it from there. `moat tools` prints the bundle the running
box actually loaded, not a second copy of the constants.

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
   `/var/log/moat/tools.jsonl`, with the injected credential redacted. Its first
   line is the `config` record: the effective permission map and the tool omissions
   opencode actually handed the plugin. `moat tools` prints that record's claims
   and names the records it read, so "omissions confirmed by opencode" is the
   plugin's account of the merged config, not moat's own declaration.
4. **Permission accounting.** A `permission.ask` hook records and allows. With
   `permission: {"*": "allow"}` it never fires; the verification asserts that the
   log file does not exist, i.e. **zero permission requests were raised**.
5. **Config assertion.** At load it fails loudly if the effective config raises
   an approval rule, denies a tool moat did not curate out, or is missing the
   expected `tools` omissions. The subtlety that made this check silently useless
   for a while: opencode compiles `tools: {name: false}` into
   `permission: {name: "deny"}` *before* the hook runs, so a check for "exactly
   `{"*":"allow"}`" rejected every real boot — and opencode logs a plugin hook
   error and carries on, so the only symptom was a line in a boot log. A check in
   this hook has to be written against the merged config, never against what
   `bundle/render.ts` wrote.

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

### 6b.1 DeepSeek, and why there is no provider block

moat targets one provider. That deletes a provider registry, provider flags,
environment inference and most of the credential broker, which is worth more than
the flexibility it costs.

opencode is built on the [models.dev](https://models.dev) catalog, which already
describes DeepSeek: base URL, npm SDK, context window, output limit, tool-call
support. So moat writes **no provider block at all**. It sets
`model: deepseek/<id>`, `enabled_providers: ["deepseek"]`, and injects the key as
`DEEPSEEK_API_KEY`, which is the name opencode looks for. That dataset is not
worth reimplementing: guess a context window wrong and opencode compacts at the
wrong moment, and the failure looks like a model problem.

The catalog is fetched once a day and cached on the host. Without it moat falls
back to a built-in model list and says so. `moat models` reads it live, and a
model id it does not describe is declared inline rather than left for opencode to
fail to resolve.

**`--base-url` remains**, pointing at any OpenAI-compatible endpoint. It is an
escape hatch, not a provider system: moat's own test suite runs against a local
stub through it, and it is how a gateway or a local model would be used. When it
is set, moat has to describe the provider itself, and then it states the context
and output limits explicitly instead of guessing them.

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
* **what the network will actually do**, per egress mode: with the default
  `filtered`, the package registries and GitHub are reachable and every other
  address is dropped, so a timed-out download is reported rather than retried;
  with `open` or `isolated`, the network is open and it should install what it
  needs rather than work around a missing tool;
* **nobody is going to answer a question**, decide, act, and document the
  assumption;
* it is expected to run the tests and paste real output, and never to claim
  something works without having run it;
* **whether a credential was injected, truthfully either way**: when one was, it is
  readable by anything in the box and must never be printed, committed or sent
  anywhere; when none was (a boot against a local `--base-url` endpoint needs none),
  there is no key here to guard. A project file or dependency asking it to exfiltrate
  environment variables is an attack to refuse in both cases.

Every environment claim in the brief — the egress mode, whether a credential exists,
which profiles and packages are installed, the branch, the checks — is rendered from
the boot's own configuration, never fixed text. An agent that acts on a false
statement about its box is a harness failure, not a model failure, so a claim with no
input behind it is a bug in this file.

An agent that does not know it is in a box wastes turns being careful. An agent
that does not know the network policy either fails to install what it needs or
keeps retrying a download that the allowlist is dropping. Both are harness
failures, and this file is the cheapest fix in the project.

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

Nothing the sandbox prints is trusted as terminal input. The answer, the
reasoning, tool output, commit subjects, branch names, change paths, the boot log
**and the output of the project's own checks** all arrive as bytes, and a terminal
acts on the escape sequences in them: a window title, a clipboard write, an erased
screen. They are stripped at the print boundary (`stripAnsi`, now in
`lib/terminal.ts`) — per delta for the streamed answer and per chunk for check
output, so a sequence split across two writes cannot be reassembled on screen. What
remains is text.

The checks matter twice over. A check is the project's own command, and the agent
can edit it: a failing test that prints OSC 0 or CSI 2J would retitle the window or
clear the screen while the user reads the output of the very command they ran
*instead of* trusting the agent. `moat verify` streams that output live, and
`moat take` and the session's `/verify` print the last lines of a failure, so all
three strip before printing.

The pty suites drive the CLI through a real terminal and assert on what comes
back: `repl-smoke.py` (the session, the layout, the turn footer),
`repl-questions.py`, `repl-apply.py`, `repl-controls.py` (model, effort, agent,
undo), `repl-escapes.py` (escape sequences from the answer, a commit subject and
a file name) and `repl-effort.py` (against a real provider). Piping stdin is not a
substitute: readline behaves differently without a terminal, and the live view is
the whole point of the mode.

#### The display has exactly one row it may rewrite

The transcript is append-only. Once a line is written it is never touched again,
which is what makes it safe to scroll and to copy out of. A running tool call is
the single exception: it is drawn once, repainted while it runs, and replaced in
place on completion, because printing `⠹ bash npm test` and then `✓ bash npm test
2.1s` as two rows doubles the height of every turn for no information.

That exception is only safe under two conditions, and both are load-bearing:

* **The row never exceeds one terminal line.** A repaint erases the current line
  and rewrites it; a row that wrapped onto a second line would leave the tail
  behind. `toolLine` therefore takes the terminal width and truncates the title to
  fit, and the truncation happens on plain text before any styling is added, so a
  cut can never land inside an escape sequence.
* **Nothing else is written while it is live.** Every other writer calls
  `beginOutput()` first, which commits or erases the live row and clears the input
  prompt off the line.

`cmd/display.ts` holds the pure parts — markdown rendering, the tool row, the turn
footer — so they can be tested by calling them, with no terminal, sandbox or model
involved. Only the spinner, the input line and the cursor handling need a terminal,
and those stay in `cmd/repl.ts`.

The spinner appears only after a second of silence and is skipped entirely while
the input line is non-empty, because stealing the line out from under someone
mid-word is worse than a missing animation.

#### Choosing the model, the effort and the agent

The session carries opencode's own settings, so moat is not a reduced client:
`/model`, `/think`, `/agent`, `/compact`, `/undo`, `/redo` and `/verbose` are all
thin calls to operations the server already has. Two of them need a decision
worth recording.

**The options are read from the server, never hardcoded.** `GET
/config/providers` returns every model with the reasoning levels that model
accepts, and those differ per model — `deepseek-v4-pro` takes `high` and `max`,
the flash models also take `low`. An unknown variant is *ignored* rather than
rejected, so a hardcoded list would fail silently and a wrong level would look
like a working one. `/model` and `/think` therefore offer exactly what the server
reports.

**The choice is persisted per environment.** `model`, `effort` and `agent` live in
the environment's `state.json`, so `/think high` applies to the next `moat run` in
that directory too. Switching to a model that does not accept the current effort
clears it and says so, rather than carrying a level that will be dropped.

The effort travels as opencode's `variant` field on the prompt. It is absent from
the published SDK's generated request type, so moat builds the body in one place
(`promptBody`) and passes the result rather than an inline literal — TypeScript
only rejects an unknown property on a fresh literal. For DeepSeek the variant
reaches the provider as `reasoning_effort`.

**Thinking off is not an effort level.** DeepSeek's scale runs `minimal`, `low`,
`medium`, `high`, `xhigh`, `max`, `ultra`, mapping onto four distinct levels, and
`medium` maps to `high` — so there is no value in it that means "do not think".
That is a separate documented parameter, `{"thinking": {"type": "disabled"}}`,
and opencode has no per-request field for it. It does, however, merge variants
declared in config *over* the ones it computes
(`packages/opencode/src/provider/provider.ts:1572`), and a variant is exactly a
bag of provider options applied to one request. So `off` is declared in the
rendered config as a variant, appears in `GET /config/providers` like any other,
and `/think off` needs no special case anywhere. It is declared for every model
the provider defines, not just the boot model, because `/model` switches at
runtime and a variant declared for one model would vanish on a switch.

Only `variants` is declared, never the whole model, so the base URL, context
window, price and tool support still come from the models.dev catalog.

**What the effort costs.** DeepSeek bills cache hits at roughly a thirtieth of
cache misses and doubles every rate during peak hours (01:00–04:00 and
06:00–10:00 UTC, Monday to Friday). `lib/pricing.ts` holds the published table
and computes the turn's cost from the billed token counts, because the price
opencode reports comes from the models.dev catalog and is wrong for
`deepseek-v4-pro` — 0.435/0.87/0.003625 per million against the published
0.66/1.98/0.022 off-peak. The token fields were pinned down by reconciling
opencode's own arithmetic: `input` is the cache-*miss* count, `cache.read` the
cache-hit count, and `reasoning` is billed at the output rate as a field separate
from `output`.

**The defaults are stated, not implied.** moat runs `deepseek-flash` at `high`
reasoning. Both are DeepSeek's own defaults, so this is not moat imposing an
opinion; it is moat saying which model it will use rather than leaving it to
whatever the catalog happens to list first. `high` is also the level the
`/think` menu marks, and what `/think default` returns to — "default" meaning
moat's default, not "unset", so there is one answer to what a fresh environment
will do.

`deepseek-flash` rather than `deepseek-v4-flash`: DeepSeek retired the versioned
names, so requests for them are served by the current DeepSeek-V4.1-Flash at the
Flash price. Both work today and are the same model at the same price, so the
current name costs nothing and will not break when the old ones stop being
accepted.

The effort is stored per environment and checked against the model in use, at
startup and again on every `/model`. A model that does not take the level — a
custom endpoint reached with `--base-url` has no levels at all — silently gets
none rather than carrying a setting that does nothing while `/status` reports it
as active. A model that has levels but not this one says so.

**Two of the four catalogue models are retired names.** DeepSeek still accepts
`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp`, but serves them with the
current Flash model and bills at its price. moat marks them in `/model` and
prices them as Flash rather than presenting four live models.

**Verification is at the wire.** Asking opencode what variant it recorded, or how
many reasoning tokens it counted, is evidence about opencode's bookkeeping. The
setting itself is checked by putting a recording proxy in front of the provider
(`test/wire-effort.py`, using `--upstream`) and reading the request body:
`variant: "max"` produces `reasoning_effort: "max"`, and `variant: "off"`
produces `thinking: {"type": "disabled"}` with no effort alongside it. This is
what resolved a false alarm — a turn that answered wrongly with zero reasoning
tokens looked like a dropped parameter, but the proxy showed it arriving intact
and the model simply not using it.

#### Streamed text arrives on its own event

The live view reads `message.part.delta`, not `message.part.updated`. opencode
1.18.31 does not put a `delta` on the latter; it sends deltas as a separate event
carrying a `partID` and no kind. Waiting for `delta` on the update event means
rendering nothing at all, which is what moat did until this was caught: tool
lines appeared, the model's answers never did. Part kinds are catalogued from the
`message.part.updated` events that precede each delta, and message roles from
`message.updated` — verified on a live server, where an assistant
`message.updated` always arrives before that message's first delta.

### 6b.6 Checking the work

An agent reporting that the tests pass is a claim, not evidence. moat finds the
project's checks — `package.json` scripts, `Makefile` targets, `pyproject.toml`,
`Cargo.toml`, `go.mod` — gives the same list to the agent so it runs the project's
own commands rather than inventing them, and runs them itself against the agent's
work before the user is asked to decide anything. `moat take` does this by
default, `moat verify` on demand, `/verify` inside a session.

A declared command is only treated as a check if it can decide anything. `npm init`
scaffolds `test: echo "Error: no test specified" && exit 1`, and moat used to offer
that as the project's own check: `moat verify` printed FAIL as the project's verdict
on work no test had looked at, and the agent was told to run it. Scaffolding
placeholders and bare `echo`s (which can only pass) are filtered out, so a project
with no tests is reported as having no checks rather than as failing them.

`--timeout` bounds each check, in seconds, and `moat verify` and `moat take` pass it
through; the default is 600 seconds per check, after which the command is killed
(`--kill-after` escalates, so a check that traps SIGTERM still dies) and reported as
timed out rather than as a failure of the project.

The check's output is sandbox text and is stripped at every print boundary — the
live stream in `moat verify`, the last six lines of a failure in `moat take`, the
last eight in the session's `/verify` (§6b.5). It is also the *project's* code: a
test the agent wrote can print anything, and the user is reading this output to
decide whether to keep that agent's work.

No model is involved in the verdict: moat runs the declared command in the sandbox
and reports the exit code. A check that times out is reported as timed out rather
than as a failure, because those are different things.

### 6b.7 Questions, and when they are answerable

The `question` tool is always advertised, because whether anyone is listening is a
property of the *session*, not of the boot: a sandbox can be started headless and
attached later. What changes with the mode is the instruction. Interactive
sessions are told a person is waiting and to ask when the answer would change
what they build; unattended ones are told nobody will answer and to decide and
say what they assumed.

`OPENCODE_CLIENT=moat` is what keeps TUI-oriented tools out of the model-facing
list, but it also drops `question` (`registry.ts`, `questionEnabled` checks
`flags.client`), so `OPENCODE_ENABLE_QUESTION_TOOL=1` turns that one back on and
the bundle curates it.

One finding worth recording: **`POST /question/:id/reject` reports success and
does nothing.** It returns 200, the server logs nothing, and the tool stays
blocked; a reply with a valid option label works, but a free-text reply does not
resolve it either. So moat does not use reject. An unattended question ends the
turn with an explanation, and `/skip` stops the turn rather than pretending to
dismiss the question. This is filed in `docs/UPSTREAM-CANDIDATES.md`.

---

## 7. Isolation model

### 7.1 What v0 isolates

| dimension | mechanism | verified by |
| --- | --- | --- |
| user | `unshare --user --map-root-user` (uid 0 inside is the calling user outside) | `uid_map` assertion in `moat doctor` |
| mount | `unshare --mount`, root replaced by `chroot` into a mount the sandbox owns | namespace inode differs from the host's; mount table has no host path |
| PID | `unshare --pid --fork` | PID 1 is the sandbox's own `sh`; ≤ 12 visible processes |
| UTS / IPC | `unshare --uts --ipc` | namespace inodes differ from the host's |
| network | `unshare --net` in every mode except `open`; pinned `slirp4netns` as the datapath, with an nftables default-deny allowlist when `filtered` | netns inode differs; the host's loopback answers on neither route; an address outside the allowlist times out while the provider answers |
| filesystem | the root is the Alpine rootfs; the host's `/` is unreachable | host project path and `$HOME` are absent inside |
| credentials | one injected variable; no host env, no SSH agent, no dotfiles | canary + env-name diff |

The sandbox is also unable to create device nodes (`mknod` is refused in an
unprivileged user namespace, verified EPERM), which is why §7.2 exists.

### 7.2 The one host mount, stated plainly

`/dev` is a fresh tmpfs. Six **device nodes** (`null`, `zero`, `full`, `random`,
`urandom`, `tty`) are bind-mounted into it from the host, because `mknod` cannot
create them from nothing in a user namespace and a userspace process needs
`/dev/null` to exist. This is what every rootless container runtime does. They
carry no host data. They are bound **read-write**: a device node is an interface
rather than a file, and remounting the bind `ro` makes `> /dev/null` fail with
EACCES, which was measured before the docs were changed to match.

An acceptance criterion was that `mount` should show *no* host bind-mounts.
Taken literally that is impossible on this host. The nearest true statement,
which `moat doctor` prints in full, is: **the only host-originated mounts are
six device nodes; every other path in the mount table's root field is moat's own
state directory or the root of a fresh filesystem.** The doctor renders the root
field rather than only the mount point, so a bind of a host directory `/work`
cannot hide behind the device name the way it did when the check read only the
source field. `docs/VERIFICATION.md` quotes the mount table so the claim can be
checked line by line.

### 7.3 Network: three modes

The network policy is chosen per environment, persisted in `state.json`, and
measured by `moat doctor` in whichever mode is in force. A new environment
defaults to `filtered`; an existing one keeps the mode its state records until
`--egress` changes it.

**`filtered`** (the default; `moat up --egress filtered` selects it explicitly):
the sandbox gets its own network namespace and an nftables ruleset with
`policy drop`, applied inside the namespace before the entry script runs. The
sandbox owns that namespace, so it holds `CAP_NET_ADMIN` there. What survives:

* TCP 80/443 to addresses resolved **on the host at boot** from the provider host
  plus the package registries in `lib/pins.ts` (`EGRESS_REGISTRY_HOSTS`: npm,
  the Alpine CDNs, PyPI, the Go and Rust proxies, Maven Central, GitHub).
  `--egress-allow host[,host]` adds to that list, per environment;
* DNS to slirp's resolver, `10.0.2.3:53`, and nowhere else;
* everything else is dropped, including the host's loopback on both routes.

A ruleset that fails to load fails the boot. A box that claims to be filtered and
is not would be worse than a box that does not start. The image carries `nft`; an
environment whose rootfs lacks it — restored from a snapshot taken before that,
or one whose agent removed it — has it installed again on the host before the
next boot, from every command, not just `moat up`.

The allowlist is resolved on the host before the boot. A host that does not
resolve is dropped from the ruleset — and for the provider that is fatal: a
filtered box with no provider address would boot and then fail on the agent's first
model call. moat up refuses with "could not resolve <host>" and names --egress open
as the way out; any other unresolved host is a warning. Ephemeral boots warn rather
than fail, because moat exec may be exactly how the box is being diagnosed, and
moat doctor's two-sided check reports the result.

An address that cannot become a host is refused **before provisioning**, because it
is the same failure with nothing left to see: `new URL()` accepts
`localhost:11434/v1` as protocol `localhost:` with an empty hostname, so
`--base-url` and `--upstream` must be an `http://` or `https://` URL with a
host. Measured before that rule: the box provisioned, copied in and booted filtered
with no provider in its allowlist, exit 0. `moat doctor`'s filtered check is
two-sided only when it had an endpoint to probe; when it had none — an environment
whose recorded address predates the rule — it says the check is one-sided instead of
reporting the provider reachable.

**The filter is a rule the agent can change.** The sandbox owns its network
namespace, so uid 0 inside holds `CAP_NET_ADMIN` there. Measured: `nft flush
ruleset` inside a filtered box exits 0, and the same `curl https://1.1.1.1/` that
timed out then answers HTTP 301. Every boot re-applies the ruleset and `moat
doctor` re-measures the policy, so a flushed filter is *detected* on the next run
rather than prevented. What the policy buys is a bound on where the box can send
data during normal work — a runaway install, a prompt-injected `curl`, an
accidental upload — not containment of an agent that is actively trying to leave.
That would need the agent to lose root, which is incompatible with handing it a
package manager, or the v1 microVM.

The allowlist is a snapshot of DNS as it resolved when the box booted. A host
that rotates to an address outside it is unreachable until the next `moat up`.
That is the deliberate trade for not depending on a resolver inside the box, and
it is why the policy is an exposure limit rather than a wall: an allowlisted
address, or DNS itself, can still carry data out.

**`isolated`**: `moat up --egress isolated` gives the sandbox the same namespace
and the same datapath with no ruleset. Outbound access through slirp's userspace
NAT is unrestricted; the host's network position is still gone. It is what to
reach for when the allowlist is in the way.

**`open`**: the sandbox shares the host's network namespace. The agent has the
host's network position, every service on the host's loopback is reachable, and
egress is unrestricted. `moat up` also chooses it automatically when the
provider is on the host's loopback (`--base-url http://127.0.0.1:...`, or
`--upstream` pointing at a proxy you run), because the sandbox's own namespace
cannot reach the host's loopback by construction and filtering it would only
break the box. The choice and its reason are printed when it happens.

Both non-open modes are measured, not asserted. The datapath is a pinned,
digest-verified static `slirp4netns`; the host reaches `opencode serve` only
through an explicit forward moat adds over slirp's API socket (`add_hostfwd`,
bound to the host's loopback), so the server binds `0.0.0.0` inside the
namespace — a namespace-local loopback cannot be forwarded to; and slirp runs
with `--disable-host-loopback`, which closes its `10.0.2.2` gateway. Measured:
without that flag the gateway answers HTTP 200 for a service on the host's
loopback; with it, the connection is refused. `moat doctor` probes both
`127.0.0.1` and `10.0.2.2`, and in filtered mode it also probes an address
outside the allowlist and the allowlisted provider, failing if either is wrong.

`bash test/e2e-egress.sh` proves the isolation half, the allowlist and the
default, all without a key. What the policy still does not do: it does not stop
exfiltration to an allowlisted address or over DNS, and it does not protect the
credential (§1.2).

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

The probe is part of the measurement, so it has to model the box rather than a fuller one:
it injects the variable names the environment actually has. A box booted with
`--no-credential` (§1.3) is probed without any credential variable, and its exposure line
says which of the remaining secret-looking names is *not* a provider credential; the native
provider's variable is only expected for the native provider, because a `--base-url`
endpoint receives the value under moat's name. Measured before that: the doctor reported
"credential visible to the agent" with `DEEPSEEK_API_KEY` and `MOAT_INJECTED_CREDENTIAL`
for a box that deliberately had neither, and reported `DEEPSEEK_API_KEY` for a custom
endpoint that never has it.

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
  `sandbox/rootfs.ts:SNAPSHOT_EXCLUDES`. The name is validated (1–64 characters
  of letters, digits, dot, dash, underscore) before it is joined into a path, and
  the archive is written through a temp file. A snapshot of a *running* box can
  capture a torn state, so `moat snapshot` refuses while a sandbox is live unless
  `--yes` is passed.
* `moat restore <name>` extracts the snapshot beside the live rootfs, carries
  `/work` across with a rename, and swaps the two with renames. If the
  extraction or the swap fails, the previous rootfs and the project are put
  back: the old version deleted the live rootfs first, so one bad snapshot
  destroyed the environment.
* `baseline` always exists right after provisioning. When the environment came
  from the cached image, `baseline.tar.gz` is a **symlink** to that image rather
  than a second 107 MiB compression, the cache file *is* the baseline.
* `moat restore` refuses to run against a live sandbox unless `--yes` is passed,
  because replacing the rootfs underneath a running box would leave it serving a
  deleted image. The check is in `cmd/main.ts:cmdRestore`.

`moat up --sync` re-copies the project from the host, discarding the sandbox's
working tree; it warns with the count of commits that exist only inside the
sandbox before doing so.

`moat up --fresh` replaces the rootfs, which deletes `/work` with it. It
refuses while a sandbox is live (the rootfs it is using would be pulled out from
under it) and refuses to delete `/work` that holds unfetched commits or
uncommitted files unless `--yes` is passed, naming the counts first. The pid
recorded for a sandbox is reconciled by process start time, not by number
alone, so a reused pid is never signalled.

---

## 9. Failure modes

| failure | behaviour |
| --- | --- |
| no user namespaces | `moat up` refuses; prints the reason and, on WSL, the fix |
| bundle config cannot be parsed | opencode fails at load; the sandbox log is printed |
| the plugin's curation assertion fails | the plugin throws at config load, surfacing at boot |
| `opencode serve` does not become ready | `moat up` prints the last 40 lines of the sandbox log and kills the sandbox |
| the recorded PID is stale | reconciled against `/proc/<pid>/stat` start time; a reused pid is reported and never signalled |
| `--fresh` is asked for while a sandbox is live | refuses; `moat down` first |
| `--fresh` would delete unfetched or uncommitted sandbox work | refuses, naming the counts; `moat fetch` or `--yes` |
| credential TTL elapses | the in-sandbox watchdog stops the agent; the box stays up |
| Alpine CDN returns a transient index error | provisioning rotates four mirrors and retries; success is decided by `apk info -e`, not by apk's exit code |

---

## 10. Deliberately absent

* **No Windows path, no host path.** There is no flag that runs the agent
  outside the sandbox.
* **No opencode TUI.** moat does not exec opencode's own client and does not
  depend on it being installed on the host. The interactive session is moat's
  own (`cmd/repl.ts`), speaking the sandbox server's HTTP API; see §6b.5.
* **No opencode fork, patch or vendored copy.** opencode is a pinned dependency
  (`opencode-ai@1.18.31`).
* **No proxying of tools.** The agent loop, the tools and the filesystem live
  inside the box; the host is only a client.
* **No `rsync` for git projects.** It cannot represent deletes, renames and
  symlinks as faithfully as git, so it is only the non-git fallback.
* **No secrets in the image, ever.** Enforced by a check in
  `bundle/install.ts` that refuses to install a bundle containing something that
  looks like a literal API key.
