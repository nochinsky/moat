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

* **The credential.** It is in the agent's process environment, and every
  command the agent runs inherits it: any process running as the same uid can
  read it from `/proc/<pid>/environ`. **You cannot hide a credential from a
  process that must use it, running as the same uid inside the box.** Every
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
  cache/codex/0.155.1/linux-x64-musl/codex       # the pinned runtime binary
  cache/net/slirp4netns-1.3.5                    # the pinned userspace datapath
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
host reboot. Every command that ends a box reaps it, in one place
(`forgetBox` in `cmd/main.ts`): the record in `state.json` is the only hold anything
has on that process, so `moat down`, `moat restore` and `moat destroy` stop the
recorded datapath *before* they clear or delete the record, and the restart inside
`moat up` reaps one before it overwrites the record with a new box's. Booting is what
used to make an old datapath unattributable — measured: one `kill -9`, then `moat up`
left two `slirp4netns` processes, and `moat destroy` reclaimed only the new one — and the
same record is what `down`, `restore` and `destroy` had already cleared for a box that
was gone or no longer theirs, leaving the process running with nothing on disk naming it.
A recorded pid is signalled only while its `/proc` start time still matches the record, so
a pid the host has handed to another process is left alone.

### 2.2b The agent runtime

moat ships one runtime: **Codex**, a CLI, pinned and digest-verified in
`lib/pins.ts` like slirp4netns, because it becomes the code the agent runs. The
npm platform tarball is a **musl** build, so it runs on the Alpine image with no
gcompat and no Node runtime, and provisioning extracts it to
`/usr/local/bin/codex`.

Codex is not a server, so the long-running box is a keepalive
(`codexEntryScript`). Its only jobs are to exist — so `moat status`, `down` and
`destroy` keep their meaning — and to enforce the credential deadline the host
passes as `MOAT_CREDENTIAL_EXPIRES_EPOCH`; it prints that the runtime is ready
and sleeps. Everything that runs the agent runs in its own ephemeral boot of the
same rootfs, the way `moat exec` does: a task is
`codex exec --json --skip-git-repo-check <prompt>`, and an interactive session
is Codex's own TUI, with a prompt or without one. The host attaches a pty for
the second and parses the JSONL event stream of the first; it never runs a tool
itself.

The agent's policy is two files moat renders on **every** boot through the rootfs
guard (`bundle/codex.ts`, `bundle/instructions.ts`), never baked into an image and
never left to whatever the agent wrote in `~/.codex` last boot. The config
(`/root/.codex/config.toml`) carries `approval_policy = "never"` and
`sandbox_mode = "danger-full-access"`, so moat's box is the only boundary and no
approval prompt can fire; the brief (`/root/.codex/AGENTS.md`, Codex's global
instruction file) describes the boot that was actually made. `installCodexFiles`
refuses to write either file if it looks like it carries a literal API key.

A missing runtime binary is **repaired, never re-provisioned**. The agent is root
in its own rootfs and can `rm /usr/local/bin/codex`, and an environment made by an
older moat never had it, so the next boot copies it into the live rootfs
(`installRuntimeBinary`). Provisioning would delete the rootfs first and take
`/work` — the agent's uncommitted work — with it, which is measured in
`docs/VERIFICATION.md`; the image cache key names the binary and its pinned
version, so a cached image cannot silently lack it.

One consequence worth stating because it is easy to get wrong: an **interactive**
boot (`moat`, `moat shell`) forwards the host's `TERM` into the box, sanitised to
a capability name, because Codex's TUI and bash both need a real terminal type — a
batch boot keeps `TERM=dumb`, so nothing the suites measure changes.

The runtime that came before was a server inside the box, and the two do not cost
the same per turn: on one identical trivial task Codex used 17,692 tokens
($0.000259) against opencode's 9,363 ($0.0000937), because it carries a larger
harness prompt and does more work per step. The method and the fields that make
the arithmetic honest are in `docs/RUNTIME-COST.md`; where the old runtime's
claims went is `docs/RUNTIME-MIGRATION.md`.

### 2.3 Boot sequence, the exact commands

`moat up` performs, in order:

1. **Host capability probe** (`lib/host.ts:probeHost`). If unprivileged user
   namespaces are unavailable, moat **refuses to run**. There is no host
   fallback, by design: requirement 2 says sandbox is the only mode.
2. **Provision** (first time, or `--fresh`), `sandbox/rootfs.ts`:
   * the Alpine minirootfs and the pinned Codex tarball are checked against the
     digests in `lib/pins.ts` (the release directory's SHA-256 and the platform
     tarball's `sha256`). A mismatch, including one in an already-cached file, is
     re-downloaded rather than unpacked. Cache writes go to a per-call temp file
     and are renamed into place, so two moat processes cannot interleave into one
     `.part`;
   * if a cached image for this `(alpine version, codex version, package set)`
     exists on the host, extract it and skip the network entirely (the image cache
     carries a `.sha256` sidecar written when it was built, and a mismatch
     rebuilds it);
   * otherwise download and extract the Alpine minirootfs on the host (no
     privileges),
   * boot a throwaway sandbox and run `apk add` **inside it** for
     `bash git curl ripgrep libstdc++ ca-certificates coreutils util-linux
     findutils diffutils patch` (plus `nftables` unless `--egress open` — see
     `PROVISION_PACKAGES`),
   * extract the pinned Codex binary to `/usr/local/bin/codex`,
   * create `/root/.codex` and the other directories a rootfs needs, and write a
     sandbox-owned git identity to `/root/.gitconfig`. The config and the brief
     are deliberately **not** baked in: `moat up` renders them on every boot, so
     there is one place that decides the policy and a cached image cannot serve a
     stale one;
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
mount --make-rprivate /                             # or the boot refuses to continue
mount --bind  <rootfs> <mnt>              # the root becomes a mount point
mount -t proc proc <mnt>/proc
mount -t tmpfs -o mode=755,nosuid tmpfs <mnt>/dev
mount --bind  /dev/{null,zero,full,random,urandom,tty} <mnt>/dev/*   # device nodes (rw),
                                          # each verified with `[ -c ... ]` or the boot refuses
mount -t devpts -o newinstance,ptmxmode=0666,mode=620 devpts <mnt>/dev/pts
                                          # proved mounted (mountpoint -q) or the boot refuses
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs <mnt>/dev/shm
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs <mnt>/tmp
mount -t tmpfs -o mode=755,nosuid,nodev tmpfs <mnt>/run
cp /etc/resolv.conf <mnt>/etc/resolv.conf          # a copy, not a mount
exec chroot <mnt> /bin/sh -c 'cd / && unset OLDPWD && exec /.moat/entry.sh'
```

Nothing on that list is best-effort. A step whose failure used to be swallowed — the private
propagation, the six device binds, the devpts mount — refuses the boot now, because the failure
mode is a box that looks healthy while `> /dev/null` writes into its own rootfs or `/dev/urandom`
returns nothing. `moat doctor` measures the same thing from inside, as the row **device nodes are
real devices**, and `cd /` is explicit rather than inherited from `chroot`; `OLDPWD` is unset in
the same shell, since dash's `cd` exports it and the box would otherwise carry the host's
previous directory into the environment diff.

6. **Run**: the box execs `/.moat/entry.sh`, the keepalive described in §2.2b.
   There is no server and nothing listening. A task or a session is a separate
   ephemeral boot whose entry script `cd`s to `/work` and execs
   `codex exec --json --skip-git-repo-check <prompt>` or `codex` (the TUI), on
   the pty the host handed it.
7. **Ready**: nothing to poll. The host reports the boot and the measured cold
   start; "ready" means the entry script ran.

Host and sandbox communicate over that pty and over the sandbox process's own
stdout — the JSONL event stream, for a task. **moat proxies nothing**: no
filesystem, no socket, no subprocess.

### 2.4 Commands

| command | effect |
| --- | --- |
| `moat` | open a session in the current directory — Codex's own TUI, on the terminal moat inherited. The entry point |
| `moat run "<task>"` | one non-interactive Codex turn (`codex exec --json`): tool rows, the answer, and a cost footer |
| `moat verify` | run the project's own checks against the sandbox, no model involved |
| `moat take [branch]` | fetch the agent's branch, run the checks, show its commits and diff, and offer to apply it |
| `moat up [task]` | provision if needed, copy in, mint a credential, boot the keepalive; a task runs in that boot |
| `moat fetch [branch] [--all]` | `git fetch` the agent's branch from the sandbox into `refs/moat/*` |
| `moat apply <branch> [--checkout]` | turn a fetched ref into a local branch (never automatic) |
| `moat status [--all]` | state, credential expiry, snapshots, sandbox branches |
| `moat down` | stop the sandbox, keep the environment |
| `moat destroy` | delete the environment for this project |
| `moat snapshot [name]` / `moat restore <name>` | rootfs snapshots |
| `moat exec -- <cmd>` | run one command in a fresh boot of the environment's sandbox |
| `moat shell` | interactive shell inside the sandbox |
| `moat doctor` | host probe plus the in-box isolation checks for the egress mode in force — `open`, `isolated` and `filtered` each run a different set, and the command prints the count it ran |
| `moat models` | DeepSeek models and their context windows, from the catalog |
| `moat profiles` | toolchain profiles, and the base packages every image has |
| `moat logs [name]` | tail a log (`sandbox` by default) |

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
involved. Serving it over a socket inside the sandbox instead is a v1 hardening
item; it is not built.

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
entry. moat targets DeepSeek and nothing else: for DeepSeek the endpoint, the
context window and the capabilities come from the [models.dev](https://models.dev)
catalog, and moat renders the one `[model_providers.*]` block that points Codex at
it. There is no provider registry, no `--provider` flag and no inference of a
provider from the environment.

`--base-url` still points the rendered config at **any OpenAI-compatible endpoint**
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

* The rendered config names the variable, never the value: `env_key =
  "MOAT_INJECTED_CREDENTIAL"`, and Codex reads that variable from its own
  environment. **The value is never written to disk**, so the image contains the
  name, not the secret. Verification greps the entire rootfs for the credential
  value and requires zero matches.
* The generated entry script (`rootfs/.moat/entry.sh`) contains only
  `$MOAT_INJECTED_CREDENTIAL`, a shell variable reference.
* `state.json` records `sha256:…` of the credential (16 hex chars), never the
  value. That is enough to correlate, useless to an attacker.
* The credential is **not** included in rootfs snapshots, because it is never in
  the rootfs.
* Shell commands the agent runs inherit the value, and that is the whole of it:
  there is no in-box hook that removes a variable from a process that already has
  it, and `/proc/<pid>/environ` holds it for as long as the credential lives. The
  old runtime had a hook that blanked secret-looking variables for shell commands;
  it was a speed bump, it is gone, and nothing here should read as if the value
  were concealed from the agent.

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

## 6. The agent's tools

**Requirement: the user can see what the agent can do, and no doc claims a control
moat does not have.**

### 6.1 What moat does not control

moat does not curate Codex's tool list. Codex ships its own tools — the pinned
version advertises `exec_command`, `write_stdin`, `view_image`, `web_search` and
`multi_agent_v1` among others — and there is no supported hook that removes one
from the list the model receives. The runtime before Codex had a server and a
plugin that refused tools outside a curated set, and this requirement was written
around it. Under Codex that guarantee does not exist: what bounds the tools is
moat's box, not a filter, and the docs say so rather than implying one. Closing it
properly would need an upstream hook, and v0 does not fork or patch the CLI.

### 6.2 What moat renders, every boot

What moat *does* own is the file that decides how those tools behave, and it is
written on every boot from `bundle/codex.ts` through the rootfs guard, never baked
into an image and never left to whatever the agent wrote in `~/.codex` last boot:

* `approval_policy = "never"` — no tool call raises an approval prompt, and there
  is no question to answer.
* `sandbox_mode = "danger-full-access"` — Codex does not add a sandbox of its own
  next to moat's. moat's box is the boundary; a second, weaker one inside it is
  worse than none.
* the provider block: one OpenAI-compatible endpoint, `wire_api = "responses"`,
  the model, the context window and output cap moat resolved before the boot, and
  `env_key` naming the environment variable that carries the credential (§5.2) —
  omitted entirely when no credential was injected, so Codex is never pointed at a
  name nothing sets.
* **no** `model_reasoning_effort`, and no `--effort` flag. Codex sends that setting
  only for models it has metadata for, and it has none for the DeepSeek models moat
  uses (measured in `docs/RUNTIME-SPIKE-codex.md`); moat renders none rather than
  rendering one that is silently dropped.

### 6.3 What the user can see

The tool inventory is a property of the pinned CLI version, so the honest record is
what a turn actually ran, not a list moat declares. `codex exec --json` reports one
item per tool call; the host prints a row per item with its exit status, then the
answer, then a footer with the token counts and the priced cost, and `--json` emits
the parsed turn instead. `docs/VERIFICATION.md` records the tool names and row
shapes a real turn produced.

The old `moat tools`, its bundle, its plugin and its audit log are gone. The
reasoning that produced them, and what happened to each claim they made, is in
`docs/RUNTIME-MIGRATION.md`.

---

## 6b. The harness

Everything in this section exists because the agent has to be able to work
unsupervised on real projects, with real dependencies, against real providers, 
and because a harness that is merely *configured* is not the same as one that
*works*.

### 6b.1 DeepSeek, and why the provider block is small

moat targets one provider. That deletes a provider registry, provider flags and
environment inference, which is worth more than the flexibility it costs.

Codex does not ship a working `deepseek` provider in the pinned version: 0.155.1
answers `Error: Model provider `deepseek` not found`, measured and recorded in
`docs/RUNTIME-SPIKE-codex.md`. So moat renders one `[model_providers.<id>]` block
with the base URL, `wire_api = "responses"` and `env_key` naming the variable that
carries the key.

The model, its context window and its output cap come from the
[models.dev](https://models.dev) catalog, which already describes DeepSeek: that
dataset is not worth reimplementing, and guessing a context window wrong makes the
runtime compact at the wrong moment, where the failure looks like a model problem.
The catalog is fetched once a day and cached on the host. Without it moat falls
back to a built-in model list and says so. `moat models` reads it live, and a model
id it does not describe is declared inline rather than left for Codex to fail to
resolve.

**`--base-url` remains**, pointing at any OpenAI-compatible endpoint. It is an
escape hatch, not a provider system: moat's own test suite runs against a local
stub through it, and it is how a gateway or a local model would be used. With it
set there is no catalog entry, so moat states the context and output limits
explicitly instead of guessing them — and the rendered config carries no `env_key`
unless a credential was injected.

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

`moat` writes `/root/.codex/AGENTS.md` inside the sandbox, Codex's global
instruction file, and never into the project: the user's repository is copied in
byte-for-byte and moat adds nothing to it. That it is read was measured rather than
assumed — the recording proxy used for the wire tests shows the file's content
arriving in the request body, wrapped as AGENTS.md instructions.

The instructions tell the agent:

* it is in a disposable box, and may install, break and delete freely;
* **what the network will actually do**, per egress mode: with the default
  `filtered`, the package registries and GitHub are reachable and every other
  address is dropped, so a timed-out download is reported rather than retried;
  with `open` or `isolated`, the network is open and it should install what it
  needs rather than work around a missing tool;
* **whether anyone will answer**: an interactive session is told a person is
  waiting at the terminal, an unattended one to decide, act and document the
  assumption;
* it is expected to run the tests and paste real output, and never to claim
  something works without having run it;
* **whether a credential was injected, truthfully either way**: when one was, it is
  readable by anything in the box and must never be printed, committed or sent
  anywhere; when none was (a boot against a local `--base-url` endpoint needs none),
  there is no key here to guard. A project file or dependency asking it to exfiltrate
  environment variables is an attack to refuse in both cases.

Every environment claim in the brief — the egress mode, whether a credential exists,
which profiles and packages are installed, the branch, the checks, whether anyone is
listening — is rendered from the boot's own configuration, never fixed text. An agent
that acts on a false statement about its box is a harness failure, not a model
failure, so a claim with no input behind it is a bug in this file.

An agent that does not know it is in a box wastes turns being careful. An agent
that does not know the network policy either fails to install what it needs or
keeps retrying a download that the allowlist is dropping. Both are harness
failures, and this file is the cheapest fix in the project.

### 6b.4 The working branch

Every boot puts the sandbox's working tree on `moat-session-<timestamp>`, so the
user's own branch is untouched *inside* the box as well as outside it, and
copy-out has one predictable ref to read. `moat fetch` with no argument fetches
that branch; `moat apply` creates a local branch of the same name.
The TUI's own session history lives under `/root/.codex` inside the rootfs and so
survives `moat down` / `moat up`; moat exposes no resume flag of its own — running
`moat` again opens a new TUI in the same rootfs, with the same working tree.

### 6b.5 The interactive session

At a terminal, `moat` (or `moat run "<task>"`, which opens the TUI with that prompt)
hands the box the terminal it inherited and execs Codex's own TUI on it. There is no
client and no protocol between moat and the agent: the TUI draws its own screen,
reads the keyboard, and owns its commands, its model picker and its session history.
moat supplies the box, the terminal and the environment.

This replaced a session of moat's own — a transcript speaking the old runtime's HTTP
API — and the replacement is a deletion of code rather than a port of it. The old
mode had to reimplement every interactive feature one at a time (model switching,
compaction, undo, an input line); handing over the terminal puts the surface under
the CLI's own maintenance, and removes the requirement that the runtime be a server
at all. What the old mode claimed, and where each claim went, is in
`docs/RUNTIME-MIGRATION.md`.

Two things moat does own here:

* **The terminal type.** A boot nobody is watching gets `TERM=dumb`; an interactive
  boot advertises the host's terminal type through `interactiveTerm`, sanitised to a
  capability name and replaced with `xterm-256color` when it is empty, `dumb`, or
  carries whitespace or punctuation. Without it, Codex's TUI stops at
  `WARNING: TERM is set to "dumb". Codex's interactive TUI may not work in this
  terminal. Continue anyway? [y/N]` — measured the first time `moat` was run under
  this runtime, and the first thing a new user would have seen.
* **The datapath.** An interactive boot gets the same network namespace, the same
  egress policy and the same ephemeral rootfs as every other boot; `TERM` is the
  only thing the terminal changes about it.

**Leaving the TUI leaves the box running.** The keepalive is a separate process, so
the ctrl-c that ends the TUI does not stop the sandbox: `moat status` still describes
it, `moat fetch` still collects its commits, and running `moat` again opens a new TUI
in the same rootfs with the same working tree. `test/codex-tui.py` (extras section
AL) is the pty proof, and it is keyless: it drives `moat` through a real terminal and
asserts that the TUI was reached rather than the help text, that it drew a screen and
kept running, and that Ctrl-C left the sandbox running.

**Text from inside is still untrusted.** In the batch paths every string that came
out of the sandbox — the answer, tool output, commit subjects, branch names, change
paths, the boot log and the output of the project's own checks — is stripped at the
print boundary (`stripAnsi`, `lib/terminal.ts`, which removes every ESC byte so a
sequence split across two writes cannot be reassembled on screen). In the TUI the
escape sequences *are* the interface and pass through as bytes; moat does not filter
the program's own terminal output, and nothing here should read as if it did. The
batch paths are where moat chooses what reaches the user's terminal, and that is
where the stripping is enforced.
### 6b.6 Checking the work

An agent reporting that the tests pass is a claim, not evidence. moat finds the
project's checks — `package.json` scripts, `Makefile` targets, `pyproject.toml`,
`Cargo.toml`, `go.mod` — gives the same list to the agent so it runs the project's
own commands rather than inventing them, and runs them itself against the agent's
work before the user is asked to decide anything. `moat take` does this by
default, and `moat verify` does it on demand.

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
live stream in `moat verify` and the last six lines of a failure in `moat take`.
It is also the *project's* code: a test the agent wrote can print anything, and the
user is reading this output to decide whether to keep that agent's work.
decide whether to keep that agent's work.

No model is involved in the verdict: moat runs the declared command in the sandbox
and reports the exit code. A check that times out is reported as timed out rather
than as a failure, because those are different things.

### 6b.7 Questions, and when they are answerable

Codex advertises a `request_user_input` tool in the pinned version — measured on the
provider side, `test/evidence/codex-summary.txt` — so this is not a tool moat can delete,
and moat does not try. What moat controls is the instruction around it: an interactive
session is told a person is at the terminal and to ask when the answer would change what
it builds; an unattended one is told nobody will answer, to decide, do the work, and say
what it assumed in its final message.

The distinction is a property of the *boot*, not of the environment. Whether a terminal
is attached decides it (a TTY on stdin, and neither `--json` nor `--no-follow`), and the
same value decides what the brief says about asking. Getting the two out of step is how a
session ends up waiting for an answer that cannot come, so both are read from one value
(`cmd/main.ts`).

What happens when a batch turn calls `request_user_input` anyway is the CLI's behaviour,
not moat's, and it is not verified here; the docs say that rather than implying a
question channel moat implements.

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
EACCES, which was measured before the docs were changed to match. Each bind is
verified to have produced a character device — the boot refuses otherwise, and
`moat doctor` re-measures it inside the box — because the failure that matters here
is silent: a regular file at `/dev/null` accepts writes and reports success.

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
digest-verified static `slirp4netns`, and slirp runs with
`--disable-host-loopback`, which closes its `10.0.2.2` gateway. There is no host
port forward in either direction, because the box runs no server and nothing in it
listens for the host. Measured: without that flag the gateway answers HTTP 200 for
a service on the host's loopback; with it, the connection is refused. `moat doctor`
probes both `127.0.0.1` and `10.0.2.2`, and in filtered mode it also probes an
address outside the allowlist and the allowlisted provider, failing if either is
wrong.
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
| the rendered codex config cannot be parsed | Codex fails at load; the boot log is printed |
| the codex binary is missing from the rootfs | the next boot copies the pinned binary into the live rootfs; re-provisioning would delete `/work` with it |
| `codex exec` reports an error item | the errors are printed, the advisory notices are not counted as failures, and the turn's exit code is returned |
| the recorded PID is stale | reconciled against `/proc/<pid>/stat` start time; a reused pid is reported and never signalled |
| `--fresh` is asked for while a sandbox is live | refuses; `moat down` first |
| `--fresh` would delete unfetched or uncommitted sandbox work | refuses, naming the counts; `moat fetch` or `--yes` |
| the credential expires | a task boot with an already-dead credential refuses to start the agent, and the keepalive exits at the credential's own timestamp |
| Alpine CDN returns a transient index error | provisioning rotates four mirrors and retries; success is decided by `apk info -e`, not by apk's exit code |

---

## 10. Deliberately absent

* **No Windows path, no host path.** There is no flag that runs the agent
  outside the sandbox.
* **No session client.** moat does not reimplement the interactive surface: it
  hands the box the terminal and execs Codex's own TUI, so there is no transcript,
  input line or `/command` of moat's own; see §6b.5.
* **No curated tool list.** Codex's tools are the CLI's; moat does not filter, add
  to or patch them, and the box is the bound. See §6.1.
* **No opencode runtime, no fork and no vendored copy.** The server-based runtime
  is deleted rather than kept as a second path, and the CLI that replaced it is a
  pinned, digest-verified binary (`lib/pins.ts`).
* **No proxying of tools.** The agent loop, the tools and the filesystem live
  inside the box; the host is a terminal or a log reader.
* **No `rsync` for git projects.** It cannot represent deletes, renames and
  symlinks as faithfully as git, so it is only the non-git fallback.
* **No secrets in the image, ever.** Enforced by `installCodexFiles`
  (`bundle/codex.ts`), which refuses to write a config or a brief that looks like
  it carries a literal API key.
