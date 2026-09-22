# moat, specification (v0)

moat runs an AI coding agent inside a disposable, fully isolated Linux box. The host is
never touched: not by a bind mount, not by an environment variable, not by a forwarded
credential, not by the agent's writes.

This document is the contract. It describes what v0 does and where v0 falls short of the
design goals, with the evidence for each.

---

## 1. What the sandbox does and does not protect

The sandbox protects the host. It does not protect the project or the credential: the
agent has to read the project to work on it and the key to call the model, so both are
available to it, and egress policy decides who else can get them. By default the box
reaches the provider and the package registries and nothing else, which narrows the
audience without making either confidential.

### 1.1 What the sandbox protects

Verified in `docs/VERIFICATION.md` §4:

* your filesystem outside the project, `$HOME`, your other repositories, dotfiles
* your SSH keys and agent socket
* your cloud credentials, tokens and environment
* your machine's integrity: every namespace differs from the host's
* your project's **integrity**: the host copy is authoritative, the agent works on a copy,
  and nothing is applied back without an explicit `moat fetch` + `moat apply`

The host never writes outside the box on the agent's behalf either. The agent is root in
the persistent rootfs and can replace a directory with a symlink to a host path; every
host-side write resolves through `lib/rootfs-fs.ts`, which refuses to follow one (measured
in `docs/VERIFICATION.md` §M).

### 1.2 What the sandbox does NOT protect

Measured, not assumed (`moat doctor` prints all three on every run):

* **The credential.** It is in the agent's process environment and every command the agent
  runs inherits it: any process running as the same uid can read it from
  `/proc/<pid>/environ`. **You cannot hide a credential from a process that must use it,
  running as the same uid inside the box.** Every in-sandbox mitigation is a speed bump.
* **The project's confidentiality.** The agent can read every byte of the copy, and egress
  is an allowlist rather than a wall, so anything on that allowlist, or DNS, can carry
  them out.
* **Your host's loopback.** In the default `filtered` mode and in `isolated`, the sandbox
  has its own network namespace and the host's loopback is closed on both routes (§7.3).
  Only `moat up --egress open` puts the sandbox back in the host's namespace, and then
  every service on the host's loopback is reachable from inside.

### 1.3 Why autonomy is still the right default

None of the three exposures is fixed by a permission prompt: all three are reachable
through a single `bash` call, which the agent legitimately needs, so deny rules would only
make the agent ask first. The levers are:

1. **What the credential can do at the provider.** A short-lived, spend-capped token makes
   stealing it not worth the effort. moat enforces a TTL (§5.3); provider-side scoping is
   v2 work.
2. **Egress policy**, which a new environment gets by default: its own network namespace
   behind an nftables default-deny allowlist built from the provider and the package
   registries (§7.3). The remaining hole is the allowlist itself.
3. **Choosing not to put things in the box.** `moat up` names any copied-in file that looks
   like it holds a credential.

## 2. Lifecycle

### 2.1 Environment identity

An environment is keyed by the SHA-256 of the project directory's real path
(`lib/paths.ts:projectId`), truncated to 12 hex characters. `~/.moat/envs/<id>/` holds
everything:

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

`/work` lives *inside* the rootfs, the only way to get it into the sandbox without a bind
mount. Snapshots capture the rootfs (installs, caches) and exclude the project. See §8.

### 2.2 States

```
(absent) --moat up--> provisioning --> running --moat down--> stopped
                                          |                      |
                                          +-------moat up--------+
                                          |
                                     moat destroy --> (absent)
```

`stopped` is a real, useful state: the rootfs and the project copy survive, so the next
`moat up` is a warm boot. `moat destroy` is the only command that deletes an environment;
`moat up --fresh` replaces the rootfs instead, and is gated twice for exactly that reason
(§2.3).

`state.json` is metadata, not the environment: the rootfs is. If it is missing or
unreadable while `rootfs/work` is still there, `moat up` rebuilds it from the disk
(`sandbox/recover.ts`): the branch and the copy-in baseline from the sandbox repository,
the Alpine version from the rootfs. It mints a new credential, and with no recorded host
baseline the drift check reports that it cannot run. An unreadable file is kept beside the
new one as `state.json.corrupt-<time>`.

While a boot runs, `state.json` still describes the state *before* it, so `moat status`
reports `booting (pid N, Ns in)` rather than `stopped`, and `moat down`, `moat destroy`,
`moat restore` and a second `moat up` wait for it rather than acting on the stale file.
The marker is a pid *and* its start time (`sandbox/boot.ts`), so an interrupted boot
leaves nothing to wait for. Only the long-running boot takes it; ephemeral boots
(`moat exec`, `moat doctor`, `moat shell`, the checks runner) run alongside it.

A sandbox in an own-namespace mode also has a **datapath process** (`slirp4netns`) that
outlives the box if the box dies out of band: a `kill -9`, an OOM kill, a host reboot.
Every command that ends a box reaps it in one place (`forgetBox` in `cmd/main.ts`), before
clearing the `state.json` record that is the only hold anything has on the process.
Measured: one `kill -9`, then `moat up` left two `slirp4netns` processes and
`moat destroy` reclaimed only the new one. A recorded pid is signalled only while its
`/proc` start time still matches the record.

### 2.2b The agent runtime

moat ships two runtimes, chosen with `--runtime codex|claude` and recorded in `state.json` so every
later command agrees with the boot that made it. Both are CLIs, pinned and digest-verified in
`lib/pins.ts` like slirp4netns, because each becomes the code the agent runs. The npm platform
tarballs are **musl** builds, so they run on the Alpine image with no gcompat and no Node runtime,
and provisioning extracts them to `/usr/local/bin/codex` and `/usr/local/bin/claude`.

**Codex** is the default. `--permission-mode`-style policy does not exist for it; the config moat
renders (§6.2) is what keeps it from asking.

**Claude Code** reads its policy from arguments, and that is deliberate: its one "allow everything,
ask nothing" mode, `--permission-mode bypassPermissions`, is **refused when the process is root**,
which moat's agent is (`docs/RUNTIMES.md` has the measurement, and why a non-root agent user is not
available in a single-id user namespace). moat renders an **allowlist** instead —
`--permission-mode acceptEdits --allowedTools Bash Edit Write Read Glob Grep NotebookEdit` — and
because anything that would still prompt is auto-*denied* in `--print` mode rather than left
hanging, the box never asks for approval and never blocks on a question it cannot ask. Anything the
allowlist lacks comes back in `permission_denials` on the final event and is reported, so an
incomplete list is visible rather than silent. Its stream is parsed into the same turn shape as
Codex's (§2.2b), with one trap: `input_tokens` there is already the cache-miss count.

Neither runtime is a server, so the long-running box is a keepalive (`keepaliveEntryScript`): it
exists, so `moat status`, `down` and `destroy` keep their meaning, it prints that the runtime is
ready and sleeps, and it enforces the credential deadline the host passes as
`MOAT_CREDENTIAL_EXPIRES_EPOCH`. Everything that runs the agent runs in its own ephemeral
boot of the same rootfs: a task is `codex exec --json --skip-git-repo-check <prompt>` or
`claude -p --output-format stream-json`, a session is the runtime's own TUI, with a prompt or
without one. The host attaches a pty for the
second and parses the JSONL event stream of the first; it never runs a tool itself.

The agent's policy is two files moat renders on **every** boot through the rootfs guard
(`bundle/codex.ts`, `bundle/instructions.ts`): the config (`/root/.codex/config.toml`,
§6.2) and the brief (`/root/.codex/AGENTS.md`, §6b.3). `installCodexFiles` refuses to
write either if it looks like it carries a literal key.

A missing runtime binary is **repaired, never re-provisioned**: the next boot copies it
into the live rootfs (`installRuntimeBinary`) instead of provisioning, which deletes the
rootfs and takes `/work` with it (measured in `docs/VERIFICATION.md`). The image cache key
names the binary and its pinned version. An **interactive** boot also forwards the host's
`TERM`, sanitised; a batch boot keeps `TERM=dumb` (§6b.5).

The runtime before Codex was a server inside the box, and it cost less per turn: on one
identical trivial task Codex used 17,692 tokens ($0.000259) against opencode's 9,363
($0.0000937), because it carries a larger harness prompt and does more work per step
(`docs/HISTORY.md`).

### 2.2c Spend ceilings

A turn reports what it cost; by default nothing stops it. Two flags change that, and they are
enforced **while the turn runs**, not priced afterwards:

* **`--max-tokens <n>`** — total tokens (`input + cached + output + reasoning`) for the turn. It
  needs no price, so it works for any model, including a `--base-url` endpoint nobody has published.
* **`--max-cost <usd>`** — spend for the turn. It needs a price: moat's own table, or models.dev via
  the catalog. When the model cannot be priced, moat **says so and carries on** rather than passing
  silently, because a ceiling that cannot be enforced is worse than none if it reads as protection.

Enforcement is a kill, not a report. The runtime's own stream is re-read as it arrives — the same
parser the footer uses, so the number compared is the number printed — and the moment the running
total crosses the ceiling the sandbox is killed with `SIGKILL` through `unshare --kill-child`, so it
cannot outlive the ceiling and the next request is never paid for. `moat run` then exits non-zero
and names the ceiling it hit.

One honest limit, and it is the protocol's rather than moat's: **Codex sends usage only at
`turn.completed`**, so for Codex the check can only fire at the end of the turn. Claude Code reports
usage on every assistant event, so it is stopped mid-turn. `docs/SEAM.md` §3 records the same
asymmetry. There is no budget that spans several `moat run` invocations.

### 2.3 Boot sequence, the exact commands

`moat up` performs, in order:

1. **Host capability probe** (`lib/host.ts:probeHost`). If unprivileged user namespaces
   are unavailable, moat **refuses to run**. There is no host fallback.
2. **Provision** (first time, or `--fresh`), `sandbox/rootfs.ts`:
   * the Alpine minirootfs and the pinned Codex tarball are checked against the digests in
     `lib/pins.ts` (the release directory's SHA-256 and the platform tarball's `sha256`).
     A mismatch, including one in an already-cached file, is re-downloaded rather than
     unpacked. Cache writes go to a per-call temp file and are renamed into place, so two
     moat processes cannot interleave into one `.part`;
   * if a cached image for this `(alpine version, codex version, package set)` exists on
     the host, extract it and skip the network entirely (the image cache carries a
     `.sha256` sidecar written when it was built, and a mismatch rebuilds it);
   * otherwise download and extract the Alpine minirootfs on the host (no privileges),
   * boot a throwaway sandbox and run `apk add` **inside it** for
     `bash git curl ripgrep libstdc++ ca-certificates coreutils util-linux findutils diffutils patch`
     (plus `nftables` unless `--egress open`, see `PROVISION_PACKAGES`),
   * extract the pinned Codex binary to `/usr/local/bin/codex`,
   * create `/root/.codex` and the other directories a rootfs needs, and write a
     sandbox-owned git identity to `/root/.gitconfig`. The config and the brief are
     deliberately **not** baked in: `moat up` renders them on every boot, so a cached
     image cannot serve a stale policy;
   * cache the finished image for future environments, and point `baseline` at it.

   `apk add` is the only networked step, and the Alpine CDN is intermittently degraded:
   cold start was measured at 7.9s with a healthy mirror and **927s** with a degraded one.
   The cached artefact contains the packages, the binary and the bundle, no credential and
   no project (`./work` is excluded, as for snapshots).
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
                                          # each verified with [ -c ... ] or the boot refuses
mount -t devpts -o newinstance,ptmxmode=0666,mode=620 devpts <mnt>/dev/pts
                                          # proved mounted (mountpoint -q) or the boot refuses
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs <mnt>/dev/shm
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs <mnt>/tmp
mount -t tmpfs -o mode=755,nosuid,nodev tmpfs <mnt>/run
cp /etc/resolv.conf <mnt>/etc/resolv.conf          # a copy, not a mount
exec chroot <mnt> /bin/sh -c 'cd / && unset OLDPWD && exec /.moat/entry.sh'
```

      Nothing on that list is best-effort: the private propagation, the six device binds
      and the devpts mount refuse the boot on failure, because the failure is a box that
      looks healthy while `> /dev/null` writes into its own rootfs. `moat doctor` measures
      the same thing from inside as the row **device nodes are real devices**; `cd /` is
      explicit rather than inherited from `chroot`, and `OLDPWD` is unset so dash's `cd`
      cannot leak the host's previous directory into the environment diff.
6. **Run**: the box execs `/.moat/entry.sh`, the keepalive described in §2.2b, so there is
   no server and nothing listening. A task or a session is a separate ephemeral boot whose
   entry script `cd` s to `/work` and execs
   `codex exec --json --skip-git-repo-check <prompt>` or `codex` (the TUI), on the pty the
   host handed it.
7. **Ready**: nothing to poll; "ready" means the entry script ran, and the host reports
   the measured cold start.

Host and sandbox communicate over that pty and over the sandbox process's own stdout, the
JSONL event stream for a task. **moat proxies nothing**: no filesystem, no socket, no
subprocess.

### 2.4 Commands

| command | effect |
| --- | --- |
| `moat` | open a session in the current directory: Codex's own TUI, on the terminal moat inherited. The entry point |
| `moat run "<task>"` | one non-interactive Codex turn (`codex exec --json`): tool rows, the answer, and a cost footer |
| `moat verify` | run the project's own checks against the sandbox, no model involved |
| `moat take [branch]` | fetch the agent's branch, run the checks, show its commits and diff, and offer to apply it |
| `moat up [task]` | provision if needed, copy in, mint a credential, boot the keepalive; a task runs in that boot |
| `moat fetch [branch] [--all]` | `git fetch` the agent's branch from the sandbox into `refs/moat/*` |
| `moat apply <branch> [--checkout]` | turn a fetched ref into a local branch (never automatic) |
| `moat status [--all]` | state, credential expiry, snapshots, sandbox branches |
| `moat down` | stop the sandbox, keep the environment |
| `moat destroy` | delete the environment for this project |
| `moat snapshot [name]`/`moat restore <name>` | rootfs snapshots |
| `moat exec -- <cmd>` | run one command in a fresh boot of the environment's sandbox |
| `moat shell` | interactive shell inside the sandbox |
| `moat doctor` | host probe plus the in-box isolation checks for the egress mode in force; `open`, `isolated` and `filtered` each run a different set, and the command prints the count it ran |
| `moat models [provider]` | a provider's models and their context windows, from the catalog |
| `moat profiles` | toolchain profiles, and the base packages every image has |
| `moat logs [name]` | tail a log (`sandbox` by default) |

Flags are per command. The parser knows every flag moat has, so a typo is an error, and
each command declares the ones it reads: a flag the command does not read is refused
before it runs. `--help`, `--quiet` and `--verbose` apply everywhere, and
`moat <command> --help` prints the command list instead of running the command.

---

## 3. Copy-in contract

**Requirement: the project is COPIED into the sandbox, never bind-mounted.** Transport,
for a git project: `git clone --no-hardlinks <project> <rootfs>/work`.

* `--no-hardlinks` is not cosmetic. A plain local clone hardlinks object files, which
  would make sandbox files writable aliases of the user's repository.
* Cloning (rather than copying `.git/`) **sanitises git metadata for free**: remotes with
  embedded tokens, credential helpers and hooks do not come along. A `cp -a` of the
  project directory would carry all three.
* Host git runs with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` and
  `GIT_LFS_SKIP_SMUDGE=1`, so the result does not depend on the user's git configuration
  (`sync/copyin.ts:SANITIZED_GIT_ENV`).

File names are addressed as text. A name that is not valid UTF-8 (a raw byte such as 0xff)
cannot be read back reliably by the host-side walks: Node decodes it to U+FFFD, which is
not the name on disk, so the next lstat reports ENOENT for a file that is plainly there.
moat up refuses such a project before anything is cloned, naming the bytes; byte paths
through the host-side walks do not exist yet.

`git clone` reproduces committed state only, so the **uncommitted working tree is replayed
on top, using git itself**: `git diff --binary HEAD` from the host carries modifications,
deletions and binaries, and `git ls-files -o --exclude-standard` carries untracked files
with their modes, symlinks preserved as symlinks.

**Known v0 limitation:** gitignored paths (`node_modules`, `.venv`, `target`, and so on)
are *not* copied; the box has its own package manager and network. It is recorded in
`test/evidence/up.txt` as the `dirty`/`untracked` counts.

Git cannot carry an untracked **empty directory** or an untracked **special file** (FIFO,
socket, device). They used to be dropped in silence; they are now named on every copy-in
and in `moat up --json` as `skippedFromCopy`. Ignored paths are not listed, because not
copying those is the contract above. `rsync` (the non-git fallback) copies both.

**Non-git directories** fall back to `rsync -a --delete --exclude .git/` and are given a
fresh repository inside the sandbox (`sync/copyin.ts:ensureSandboxRepo`), so the copy-out
contract in §4 holds for every project.

---

## 4. Copy-out contract

**Requirements: explicit, user-initiated, never auto-applied.**

1. The agent commits inside the sandbox, on a branch.
2. `moat fetch [branch]` runs, **on the host**:

   ```
   git -C <project> fetch --no-tags <rootfs>/work +refs/heads/<branch>:refs/moat/<branch>
   ```

   One refspec, forced, no tags. Only the branch the user asked for crosses the boundary.
3. `moat apply` merges the agent's work into the user's directory. It is a three-way merge
   against `refs/moat/baseline`, the commit moat recorded at copy-in holding exactly what
   was copied, so a file the user changed is never overwritten by a file the agent
   changed. Overlapping edits leave the user's file untouched and are reported.
   `--dry-run` plans without writing.

### 4.1 The review surface

**Requirement: the user sees what is about to be written, and can take part of it.**

`moat apply` is not one decision. It plans first (§3's classification, four verdicts), shows
the plan, and then writes only what was chosen:

* **Whole changes** — `--only <path>`, `--skip <path>`, comma-separated and repeatable, or
  the interactive prompt, which takes the same spec. A file named in neither list is not
  written.
* **Part of a file** — `--hunks <spec>`, where the spec is `1,3-5` of the hunk list the
  review just printed, `all`, or `none`. Each hunk is listed with its line range in *your*
  file and its own diff.

Hunks are anchored to the **destination**, not the source. A hunk records the lines of your
file it replaces, so accepting a subset of them produces a coherent file: an accepted hunk
writes the agent's lines there, and a rejected one leaves the lines you already have. The
alternative — anchoring to the source and reconstructing — makes a partial accept either
drop your lines or reintroduce the rejected ones. Measured: the first version of this
anchored a merge to the merged bytes, which made a rejected hunk come back on the next
apply.

Three properties hold for every selection, and each is a unit test in
`test/unit/review.test.ts`:

* **An unselected change is not written.** `--only a.txt` leaves `b.txt` alone even when the
  plan would have applied it cleanly.
* **A conflict is never written, whatever the selection.** Conflict rows are excluded before
  the selection is read, so `--only` naming a conflicted file still refuses it and says why.
  The conflict prompt (`--skip-conflicts`, or the interactive one) is *bypassed* when the
  selection is explicit: asking about a conflict the user has already excluded is a question
  with one answer.
* **Nothing is written without a decision.** `--only`, `--skip` and `--hunks` are instructions;
  a terminal is asked, hunk by hunk; `--yes` takes everything; with none of those and no terminal,
  `moat apply` refuses and says which flag to pass. It used to write the whole plan in that
  situation, which read as "nothing is applied automatically" while doing the opposite of what a
  reviewer would have chosen.
* **The bytes written are the verified destination plus the replacement lines from the
  plan-time frozen source.** Nothing is re-read from the sandbox between planning and
  writing, and `expectedHost` — the digest recorded for the destination at plan time — is
  re-checked immediately before each write. A host file that changed under the plan is
  refused rather than merged from stale inputs.

A partial accept writes a file that is in no tree yet, so the plan is not reusable for a
second partial accept on the same file; `moat apply` re-plans. The temp files a plan merges
into are kept until `applyPlan` finishes with them (or reaped by age), because deleting them
at the end of planning made a plan single-use and made a concurrent apply skip a change
without a word.

**The accepted subset is checked for coherence before it is written.** A partial accept is a
tree no program has been in — take hunk 2 and reject the hunk that makes the project compile,
and the result cannot build — so `moat apply` runs the project's own checks against **exactly
the subset about to be written**, not the agent's full tree (which `moat verify` and
`moat take` already cover), and refuses to write when a check fails:

* on by default when the selection is **partial** (a change skipped, or a `--hunks` subset); a
  whole-tree accept is the agent's own work and is not re-checked here, because nothing has
  diverged from what the agent produced;
* `--verify` forces it even for a whole-tree accept, `--no-verify` opts out, and
  `--timeout <seconds>` bounds the checks (the `moat verify` default applies otherwise);
* the subset is assembled from **your** tree (HEAD plus uncommitted work) with the accepted
  hunks written into it, copied into a scratch tree inside the sandbox, and removed again
  afterwards — your project is not touched to run the check, and the check runs in the box like
  every other check, never on the host;
* a project with no detectable check (no test/lint/typecheck script) is written, with a warning
  that coherence was not verified, because there is nothing to run.

This is the review's own promise kept: the point of per-hunk acceptance is to take a *sound*
part of a change, and "the part you took still builds" is what makes it sound rather than
merely small.

This makes copy-out work for **any** directory: a plain directory has no repository for
`git fetch` to write into, and the baseline commit supplies the missing third input,
recorded with a temporary index so neither the working tree nor the index is disturbed.
`moat fetch` still needs a git repository *on the host*; in a non-git directory it says so
and points at `moat apply`, which merges the sandbox's tree without one.

Uncommitted work is in no ref, so no fetch reaches it: `moat fetch` names the files, and
`moat fetch --commit-worktree` commits them first. Nothing commits to a sandbox branch
unless the user asks, and the automatic re-copy in §2.2 warns instead of overwriting work
the host cannot reach. **Every ref in the box counts, not just the one checked out**:
every branch and tag tip *and* the commit HEAD points at. Each tip is checked against the
host, and a host that is not a repository counts every commit the agent added. Measured: a
HEAD-only count let the re-copy destroy a branch, its commit and its file while the
warning said the sandbox held nothing; taking branches and tags but not HEAD did the same
to a detached-HEAD commit. With HEAD detached the warning names the commands that keep the
work (`moat exec -- git -C /work branch keep`, then `moat fetch keep`), because
`moat fetch` reads branches.

Guarantees, both verified in `docs/VERIFICATION.md`:

* **The working tree is never modified.** `moat fetch` adds objects and one ref under
  `refs/moat/`. It does not move `HEAD`, touch the index, or touch a single tracked file;
  the verification recomputes a full tree hash (paths + modes + symlink targets + content)
  before and after and requires the digests to match.
* **Nothing is applied automatically.** After `moat fetch`, the user's checkout is exactly
  as it was; the agent's work is visible at `refs/moat/<branch>`.

**Copy-out names the credential it carries.** The agent must read the injected credential
to call the model, so it can write it into the project; the brief's instruction not to is
advice, not a control. Both copy-out paths compare what they hand over against the
credential values the host can see (the names moat reads, `DEEPSEEK_API_KEY` and
`MOAT_CREDENTIAL`, and the credential store) and print the matches. `moat fetch` searches
every commit the fetch brought in, not only the tip, so a key committed and later deleted
is still named; `moat apply` searches the content before writing it and names the files in
the plan.

It is a warning, not a gate: the user asked for the work and still gets it. It does
**not** cover a credential rotated between boot and copy-out (the sandbox holds only a
fingerprint), a secret found elsewhere, commits older than the most recent 50 in the
fetched branch, or, for `apply`, a file larger than the scan limit. Every bound is named
when reached, and a file that does not match is not a claim that it is clean.

The sandbox's repository is a directory on the host's filesystem
(`envs/<id>/rootfs/work`), so the host can name it as a git remote. Serving it over a
socket inside the sandbox is a v1 hardening item; it is not built.

---

## 5. Credential axiom

**Requirements: inject one scoped, short-lived credential at boot. Never bake keys into
the image. Never forward host env, SSH agent, or dotfiles.**

### 5.1 Where it comes from

`secrets/broker.ts`, in precedence order:

1. `--credential` (literal; discouraged, because it lands in shell history),
2. `--credential-env NAME`, reads one named variable from the host,
3. `~/.moat/credentials.json` (mode must be `0600`; moat refuses to read a group- or
   world-accessible credentials file),
4. `DEEPSEEK_API_KEY`, or `MOAT_CREDENTIAL` as an override.

At a terminal, if none is present, moat asks for the key rather than explaining that one
is missing: the input is hidden, the key is checked against the provider before it is
saved, and it is written to `~/.moat/credentials.json` with mode 0600. A key that cannot
be checked because the network is down is saved with a warning rather than refused.

**moat will not silently use `OPENAI_API_KEY` (or any other general-purpose provider key)
from your environment.** It says the key is there and tells you to pass
`--credential-env NAME` if you really mean it (see §1.3).

The endpoint and model come from the configured provider, `--base-url`/`--model`, or the store
entry. **DeepSeek is the default provider, not the only one** (amended in Phase 1 of
`docs/archive/PROGRAM.md`; see the note below). `moat provider add <id> --base-url <url> [--env-var NAME]
[--model ID]` writes `~/.moat/providers.json`, and `--provider <id>`
selects one. The context window and capabilities come from the [models.dev](https://models.dev)
catalog when it describes the model, and otherwise from the model's own metadata.

Two names are known outright — `openrouter` and `openai` — and for those,
`moat provider add <id>` reads the endpoint and the key variable from that same catalog instead of
asking for them. This is a convenience and not an inference: the user still has to name the
provider, an explicit `--base-url` still wins, and a name moat does not know is refused with the
endpoint it needs rather than resolved to a guessed one. The list is short on purpose, and the gate
is whether the endpoint serves the Responses API, because the pinned runtime speaks nothing else.
It is `RESPONSES_API_PROVIDERS` in `cmd/main.ts`.

`--base-url` still points the rendered config at **any OpenAI-compatible endpoint** (Ollama,
llama.cpp, LiteLLM, a gateway), which is how the test suite runs against a local stub, and it is
what a provider written down on the command line compiles to. `--upstream` is the narrower flag,
same provider definition and a different address, for a gateway or a proxy you want to watch.

**There is still no provider registry and no inference.** A provider exists because the user
declared it or named it; `--provider` selects a thing the user wrote down rather than guessing
from the environment, an unconfigured name is refused, and a bare `moat up` is the default
provider. What Phase 1 removed was the *lock*, not the discipline: the provider id, its label,
its endpoint and the name of the environment variable its key arrives in were all DeepSeek's —
hard-coded, in the block rendered for every provider.

> **Amendment, Phase 1.** `AGENTS.md` invariant 8 says "One provider. DeepSeek. No provider
> registry, no `--provider`, no inference of a provider from the environment." `AGENTS.md` also
> says `docs/archive/PROGRAM.md` "says what to build next", and Phase 1 of that document instructs this
> change by name. Invariant 8 is therefore amended to: **no provider registry and no inference
> from the environment**, with DeepSeek as the default. The parts of the invariant that were
> about not guessing, and about `--base-url` being an escape hatch rather than the beginning of a
> provider system, are what survived, and `test/unit/provider-security.test.ts` holds them.

The **provider configuration**, the base URL and the model id, travels the same channel
but is not part of the credential: it is set whether or not one was injected. So
`moat up --no-credential --base-url http://localhost:11434/v1` boots a box that can call
that endpoint with **no `Authorization` header at all**, the mode §1.3 recommends for a
local model; an endpoint that *does* require a key fails there (401), not at moat.

### 5.2 How it enters

The value is passed as an environment variable to the sandbox's main process, the only
channel, and it is deliberately weak (see §1.2). The goal is not to conceal the key but to
make it **disposable**:

* The rendered config names the variable, never the value:
  `env_key = "MOAT_INJECTED_CREDENTIAL"`, and Codex reads that variable from its own
  environment. **The value is never written to disk**; verification greps the entire
  rootfs for it and requires zero matches. The generated entry script
  (`rootfs/.moat/entry.sh`) contains only `$MOAT_INJECTED_CREDENTIAL`, a shell variable
  reference.
* `state.json` records `sha256:...` of the credential (16 hex chars), never the value:
  enough to correlate, useless to an attacker.
* The credential is **not** in rootfs snapshots, because it is never in the rootfs.
* Shell commands the agent runs inherit the value, and that is the whole of it: there is
  no in-box hook that removes a variable from a process that already has it, and
  `/proc/<pid>/environ` holds it for as long as the credential lives. The old runtime's
  hook that blanked secret-looking variables was a speed bump and is gone.

### 5.3 How it expires

Every mint records `expiresAt = now + ttl` (default `4h`, `--credential-ttl`). The box
receives that timestamp (`MOAT_CREDENTIAL_EXPIRES_EPOCH`) as well as the TTL, and the
entry script computes how long is left **before** it starts the agent: an already-dead
credential stops the boot instead of producing an agent whose every model call can only
fail, and a live one is stopped on time by a background watchdog. Counting the TTL from
the script's own start, as v0 did at first, let the box outlive its key by however long
the boot took; the TTL remains the fallback for state that predates the epoch variable.
The next `moat up` mints a fresh credential, and `moat status` shows the remaining
seconds.

One limitation: v0 enforces the TTL by *terminating the agent*, not by revoking the token
at the provider; provider-side scoping and revocation are v2 work ("credential brokering
with expiry"). v0 does make the credential exist for one boot, in memory only, with a
recorded expiry, over a name (`MOAT_*`) allowlist.

### 5.4 What is never forwarded

`sandbox/launcher.ts:sandboxEnv()` builds the sandbox environment from an explicit
literal. There is no spread of `process.env`. The only names that cross are `PATH`,
`HOME`, `LANG`, `LC_ALL`, `TERM`, `MOAT_SANDBOX`, and the injected credential variables.

`moat doctor` verifies this from *inside* the box: it lists the sandbox's environment,
compares it against the host's, and requires that no host variable name (specifically no
`*KEY*`, `*TOKEN*`, `*SECRET*`, `*SSH*`, `*AWS*` name) appears. It also checks that the
host's `$HOME` and `$HOME/.ssh` are not reachable and that the host-only canary
(`~/.moat/canary`, mode 0600) cannot be read.

One deliberate escape hatch: `MOAT_SANDBOX_ENV` adds extra variables to the sandbox and
**rejects any name that does not start with `MOAT_`**, so it cannot replace a variable moat
manages: a caller that names `MOAT_PROVIDER_BASE_URL` or one of the credential records is
refused by name, not silently overridden.

---

## 6. The agent's tools

**Requirement: the user can see what the agent can do, and no doc claims a control moat
does not have.**

### 6.1 What moat does not control

Codex's tool list is Codex's business. The pinned version offers `exec_command`,
`write_stdin`, `view_image`, `web_search`, `multi_agent_v1` and the goal tools, and there is
no supported hook for removing one from the list the model receives. Only `web_search` is
switchable at the config level, and §6.2 explains why it is off. The runtime before Codex
had a plugin that refused tools outside a curated set; no equivalent exists here. What
bounds the tools now is the box. Closing the gap properly needs an upstream hook, and v0
neither forks nor patches the CLI.

### 6.2 What moat renders, every boot

What moat *does* own is the file that decides how those tools behave, written on every
boot from `bundle/codex.ts` through the rootfs guard, never baked into an image and never
left to whatever the agent wrote in `~/.codex` last boot:

* `approval_policy = "never"`: no tool call raises an approval prompt.
* `sandbox_mode = "danger-full-access"`: Codex does not add a sandbox of its own next to
  moat's; a second, weaker one inside it is worse than none.
* `preferred_auth_method = "apikey"` and `forced_login_method = "api"`: the provider key
  is the only authentication (§5.2), and Codex's ChatGPT/OpenAI account paths are not
  reachable from the box.
* `model_catalog_json = "/root/.codex/models.json"`, and the catalog itself, installed
  byte-for-byte beside the config on every boot. It is DeepSeek's documented Codex model
  metadata (context window, reasoning levels, tool shapes) with `model_messages` dropped
  and `base_instructions` carrying the pinned binary's own built-in prompt, so installing
  it changes metadata and never the prompt the model receives. Without it Codex prints
  "Model metadata for `<id>` not found" and falls back; with it that advisory does not
  appear.
* `model_reasoning_effort`, only when `--effort low|high|max` was passed, validated before
  provisioning against the levels the catalog declares. The rendered line decides the
  wire: through the recording stub, `high` sends `reasoning.effort = "high"` and `low`
  sends `"low"`, regardless of the catalog's `default_reasoning_level`; with no flag, the
  catalog default applies.
* `web_search = "disabled"`: DeepSeek's API accepts a `web_search` tool and ignores it
  (measured live: HTTP 200, no `web_search_call`, the model answering that it cannot
  search), so moat renders what DeepSeek's own Codex setup renders rather than advertising
  a tool that cannot work.
* the provider block: one OpenAI-compatible endpoint, `wire_api = "responses"`, the model,
  the context window and output cap moat resolved before the boot, and `env_key` naming
  the variable that carries the credential (§5.2), omitted entirely when no credential was
  injected, so Codex is never pointed at a name nothing sets.

### 6.3 What the user can see

The tool inventory is a property of the pinned CLI version, so the honest record is what a
turn actually ran, not a list moat declares. `codex exec --json` reports one item per tool
call; the host prints a row per item with its exit status, then the answer, then a footer
with the token counts and the priced cost, and `--json` emits the parsed turn instead.
`docs/VERIFICATION.md` records the tool names and row shapes a real turn produced. The old
`moat tools` and its plugin are gone; `docs/HISTORY.md` has the rest.

---

## 6b. The harness

Everything here exists because the agent has to work unsupervised on real projects, with
real dependencies, against real providers, and because a harness that is merely
*configured* is not the same as one that *works*.

### 6b.1 DeepSeek, and why the provider block is small

Codex does not ship a working `deepseek` provider in the pinned version: 0.155.1 answers
`Error: Model provider "deepseek" not found`, measured and recorded in `docs/HISTORY.md`.
So moat renders one `[model_providers.<id>]` block with the base URL,
`wire_api = "responses"` and `env_key` naming the variable that carries the key. The
pinned runtime accepts **only** `responses`: it removed the older chat protocol in February 2026
and refuses to load a config that names it, so `moat provider add --wire-api chat` is refused with
that reason rather than written into a config the box cannot start with
(`test/unit/wire-api.test.ts`). The
context window and output cap come from the [models.dev](https://models.dev) catalog,
fetched once a day and cached on the host; without it moat falls back to a built-in model
list and says so. `moat models [provider]` reads it live, and a model id it does not
describe boots with its own id as its label and **no declared limits**; it never borrows
another model's numbers, and it says so rather than staying quiet. With
`--base-url` there is usually no catalog entry, so that is the normal path rather than an
error, and the rendered config carries no `env_key` unless a credential was injected.

The model is described **once**. One record (`lib/model-facts.ts`) is resolved before the
boot and every consumer reads it: the rendered config's `model_context_window` and
`model_max_output_tokens`, the `model_catalog_json` file, the boot log, the task report and
the `--effort` check. It used to be described twice by two modules that disagreed —
models.dev knew the default model's name while the catalog handed to Codex carried the raw
id — so one boot could use two names for one model. The division of labour: models.dev
supplies which providers and model ids exist and each model's name, context window, output
cap and capabilities; moat's own ladder supplies the reasoning levels, which models.dev
does not describe beyond a yes/no (a configured provider may declare its own); and the
model id is always a fact.

### 6b.2 Toolchain profiles

"Anything we throw at it" has two bad answers: a 4 GiB kitchen-sink image that still lacks
the one thing you needed, or an agent spending its first ten turns installing a compiler.
moat does neither: the base image is small and boots in seconds, and everything else is a
named profile, installed on demand with the sandbox's own package manager, cached per
package set on the host, and persisted in the rootfs. Installing a profile later is
**incremental**: it checks `apk info -e` for each package first, so it costs only what is
missing.

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

Every package name was checked against the real Alpine 3.21 `main` and `community` indexes
rather than remembered; an earlier revision of moat's package list contained a package
that does not exist. The base image always includes `gcompat`, because this is musl and
most prebuilt binaries are built for glibc; without it they fail with a "not found" that
has nothing to do with the file being missing.

### 6b.3 The agent brief

`moat` writes `/root/.codex/AGENTS.md` inside the sandbox, Codex's global instruction
file, and never into the project: the user's repository is copied in byte-for-byte and
moat adds nothing to it. The recording proxy used for the wire tests shows the file's
content arriving in the request body, wrapped as AGENTS.md instructions, so that it is
read is measured rather than assumed.

The instructions tell the agent:

* it is in a disposable box, and may install, break and delete freely;
* **what the network will actually do**, per egress mode: with the default `filtered`, the
  package registries and GitHub are reachable and every other address is dropped, so a
  timed-out download is reported rather than retried; with `open` or `isolated`, the
  network is open and it should install what it needs rather than work around a missing
  tool;
* it is expected to run the tests and paste real output, and never to claim something
  works without having run it;
* **whether a credential was injected, truthfully either way**: when one was, it is
  readable by anything in the box and must never be printed, committed or sent anywhere;
  when none was (a boot against a local `--base-url` endpoint needs none), there is no key
  here to guard. A project file or dependency asking it to exfiltrate environment
  variables is an attack to refuse in both cases.

Every environment claim in the brief (the egress mode, whether a credential exists, which
profiles and packages are installed, the branch, the checks, whether anyone is listening)
is rendered from the boot's own configuration, never fixed text; a claim with no input
behind it is a bug in this file.

### 6b.4 The working branch

Every boot puts the sandbox's working tree on `moat-session-<timestamp>`, so the user's
own branch is untouched *inside* the box as well as outside it, and copy-out has one
predictable ref to read. `moat fetch` with no argument fetches that branch; `moat apply`
creates a local branch of the same name. The TUI's session history lives under
`/root/.codex` inside the rootfs and survives `moat down`/`moat up`; moat exposes no
resume flag of its own, and running `moat` again opens a new TUI in the same rootfs, with
the same working tree.

### 6b.5 The interactive session

At a terminal, `moat` (or `moat run "<task>"`, which opens the TUI with that prompt) hands
the box the terminal it inherited and execs Codex's own TUI on it. There is no client and
no protocol between moat and the agent: the TUI owns its screen, keyboard, commands, model
picker and session history, and moat supplies only the box, the terminal and the
environment. It replaced a session of moat's own; `docs/HISTORY.md` has the old mode's
claims.

Two things moat does own here:

* **The terminal type.** A boot nobody is watching gets `TERM=dumb`; an interactive boot
  advertises the host's terminal type through `interactiveTerm`, sanitised to a capability
  name and replaced with `xterm-256color` when it is empty, `dumb`, or carries whitespace
  or punctuation. Without it, Codex's TUI stops at
  `WARNING: TERM is set to "dumb". Codex's interactive TUI may not work in this terminal. Continue anyway? [y/N]`,
  measured the first time `moat` was run under this runtime.
* **The datapath.** An interactive boot gets the same network namespace, egress policy and
  ephemeral rootfs as every other boot; `TERM` is the only thing the terminal changes
  about it.

**Leaving the TUI leaves the box running.** The keepalive is a separate process, so the
ctrl-c that ends the TUI does not stop the sandbox: `moat status` still describes it,
`moat fetch` still collects its commits, and `moat` again opens a new TUI in the same
rootfs. `test/codex-tui.py` (extras section AL) is the keyless pty proof: it drives `moat`
through a real terminal and asserts that the TUI was reached rather than the help text,
that it drew a screen and kept running, and that Ctrl-C left the sandbox running.

**Text from inside is still untrusted.** In the batch paths every string from the sandbox
(the answer, tool output, commit subjects, branch names, change paths, the boot log, the
project's check output) is stripped at the print boundary (`stripAnsi`, `lib/terminal.ts`,
which removes every ESC byte so a sequence split across writes cannot reassemble on
screen). In the TUI the escape sequences *are* the interface and pass through as bytes;
the batch paths are where moat chooses what reaches the terminal.

### 6b.6 Checking the work

An agent reporting that the tests pass is a claim, not evidence. moat finds the project's
checks (`package.json` scripts, `Makefile` targets, `pyproject.toml`, `Cargo.toml`,
`go.mod`), gives the same list to the agent so it runs the project's own commands, and
runs them itself against the agent's work before the user decides anything. `moat take`
does this by default, and `moat verify` does it on demand.

A declared command is only treated as a check if it can decide anything. `npm init`
scaffolds `test: echo "Error: no test specified" && exit 1`, and moat used to offer that
as the project's own check: `moat verify` printed FAIL as the project's verdict on work no
test had looked at, and the agent was told to run it. Scaffolding placeholders and bare
`echo` s (which can only pass) are filtered out, so a project with no tests is reported as
having no checks rather than as failing them.

`--timeout` bounds each check, in seconds, and `moat verify` and `moat take` pass it
through; the default is 600 seconds per check, after which the command is killed
(`--kill-after` escalates, so a check that traps SIGTERM still dies) and reported as timed
out rather than as a failure of the project.

The check's output is sandbox text and is stripped at every print boundary: the live
stream in `moat verify` and the last six lines of a failure in `moat take`. It is also the
*project's* code, and the user is reading it to decide whether to keep that agent's work.
No model is involved in the verdict: moat runs the declared command and reports the exit
code.

### 6b.7 Questions, and when they are answerable

Codex advertises a `request_user_input` tool in the pinned version, measured on the
provider side in `test/evidence/codex-summary.txt`, so this is not a tool moat can delete,
and moat does not try. What moat controls is the instruction around it: an interactive
session is told a person is at the terminal and to ask when the answer would change what
it builds; an unattended one is told nobody will answer, to decide, do the work, and say
what it assumed in its final message. Whether a terminal is attached decides it (a TTY on
stdin, and neither `--json` nor `--no-follow`), and the same value decides what the brief
says about asking, so the two cannot get out of step (`cmd/main.ts`). What happens when a
batch turn calls `request_user_input` anyway is the CLI's behaviour, not moat's, and it is
not verified here.

---

## 7. Isolation model

### 7.1 What v0 isolates

| dimension | mechanism | verified by |
| --- | --- | --- |
| user | `unshare --user --map-root-user` (uid 0 inside is the calling user outside) | `uid_map` assertion in `moat doctor` |
| mount | `unshare --mount`, root replaced by `chroot` into a mount the sandbox owns | namespace inode differs from the host's; mount table has no host path |
| PID | `unshare --pid --fork` | PID 1 is the sandbox's own `sh`; <= 12 visible processes |
| UTS / IPC | `unshare --uts --ipc` | namespace inodes differ from the host's |
| network | `unshare --net` in every mode except `open`; pinned `slirp4netns` as the datapath, with an nftables default-deny allowlist when `filtered` | netns inode differs; the host's loopback answers on neither route; an address outside the allowlist times out while the provider answers |
| filesystem | the root is the Alpine rootfs; the host's `/` is unreachable | host project path and `$HOME` are absent inside |
| credentials | one injected variable; no host env, no SSH agent, no dotfiles | canary + env-name diff |

The sandbox also cannot create device nodes (`mknod` is refused in an unprivileged user
namespace, verified EPERM), which is why §7.2 exists.

### 7.2 The one host mount, stated plainly

`/dev` is a fresh tmpfs. Six **device nodes** (`null`, `zero`, `full`, `random`,
`urandom`, `tty`) are bind-mounted into it from the host, because `mknod` cannot create
them from nothing in a user namespace and a userspace process needs `/dev/null`. They
carry no host data. They are bound **read-write**: a device node is an interface rather
than a file, and remounting the bind `ro` makes `> /dev/null` fail with EACCES, which was
measured before the docs were changed to match. Each bind is verified to have produced a
character device; the boot refuses otherwise and `moat doctor` re-measures it inside the
box, because the failure that matters is silent: a regular file at `/dev/null` accepts
writes and reports success.

The acceptance criterion was that `mount` show *no* host bind-mounts, which is impossible
on this host. The nearest true statement, which `moat doctor` prints in full, is: **the
only host-originated mounts are six device nodes; every other path in the mount table's
root field is moat's own state directory or the root of a fresh filesystem.** The doctor
renders the root field rather than only the mount point, so a bind of a host directory
`/work` cannot hide behind the device name. `docs/VERIFICATION.md` quotes the table line
by line.

### 7.3 Network: three modes

The network policy is chosen per environment, persisted in `state.json`, and measured by
`moat doctor` in whichever mode is in force. A new environment defaults to `filtered`; an
existing one keeps the mode its state records until `--egress` changes it.

**`filtered`** (the default, selected explicitly with `moat up --egress filtered`): the
sandbox gets its own network namespace and an nftables ruleset with `policy drop`, applied
inside the namespace before the entry script runs. What survives:

* TCP 80/443 to addresses resolved **on the host at boot** from the provider host plus the
  package registries in `lib/pins.ts` (`EGRESS_REGISTRY_HOSTS`: npm, the Alpine CDNs,
  PyPI, the Go and Rust proxies, Maven Central, GitHub). `--egress-allow host[,host]` adds
  to that list, per environment;
* DNS to slirp's resolver, `10.0.2.3:53`, and nowhere else;
* everything else is dropped, including the host's loopback on both routes.

A ruleset that fails to load fails the boot. The image carries `nft`; an environment whose
rootfs lacks it (restored from an old snapshot, or an agent removed it) has it installed
again on the host before the next boot, from every command, not just `moat up`.

The allowlist is resolved on the host before the boot. A host that does not resolve is
dropped from the ruleset; for the provider that is fatal, because a filtered box with no
provider address fails on the agent's first model call. `moat up` refuses with "could not
resolve <host>" and names `--egress open` as the way out; other unresolved hosts are a
warning, and ephemeral boots warn rather than fail so `moat exec` can still diagnose the
box.

An address that cannot become a host is refused **before provisioning**: `new URL()`
accepts `localhost:11434/v1` as protocol `localhost:` with an empty hostname, so
`--base-url` and `--upstream` must be an `http://` or `https://` URL with a host.
`moat doctor`'s filtered check is two-sided only when it had an endpoint to probe; with
none it says the check is one-sided rather than reporting the provider reachable.

**The filter is a rule the agent can change.** The sandbox owns its network namespace, so
uid 0 inside holds `CAP_NET_ADMIN` there. Measured: `nft flush ruleset` inside a filtered
box exits 0, and the same `curl https://1.1.1.1/` that timed out then answers HTTP 301.
Every boot re-applies the ruleset and `moat doctor` re-measures it, so a flushed filter is
*detected*, never prevented. The policy bounds where the box can send data during normal
work (a runaway install, a prompt-injected `curl`, an accidental upload), not an agent
actively trying to leave; that would need the agent to lose root or the v1 microVM.

The allowlist is a snapshot of DNS as it resolved when the box booted: a host that rotates
to an address outside it is unreachable until the next `moat up`, the deliberate trade for
not depending on a resolver inside the box.

**`isolated`**: the same namespace and datapath with no ruleset. Outbound access through
slirp's userspace NAT is unrestricted; the host's network position is still gone. It is
what to reach for when the allowlist is in the way.

**`open`**: the sandbox shares the host's network namespace. The agent has the host's
network position, every service on the host's loopback is reachable, and egress is
unrestricted. `moat up` also chooses it automatically when the provider is on the host's
loopback (`--base-url http://127.0.0.1:...`, or `--upstream` pointing at a proxy you run),
because the sandbox's own namespace cannot reach the host's loopback by construction. The
choice and its reason are printed.

Both non-open modes are measured. The datapath is a pinned, digest-verified static
`slirp4netns` run with `--disable-host-loopback`, which closes its `10.0.2.2` gateway:
without the flag the gateway answers HTTP 200 for a service on the host's loopback, with
it the connection is refused. There is no host port forward in either direction, because
the box runs no server. `moat doctor` probes both `127.0.0.1` and `10.0.2.2`, and in
filtered mode also an address outside the allowlist and the allowlisted provider.

`bash test/e2e-egress.sh` proves the isolation half, the allowlist and the default, all
without a key. The policy still does not stop exfiltration to an allowlisted address or
over DNS, and it does not protect the credential (§1.2).

### 7.4 Exposures, as `moat doctor` reports them

`moat doctor` separates three kinds of finding:

* **`check`**, a property that must hold. A failure fails the run and exits non-zero.
* **`note`**, measured context that is neither good nor bad, for example a deliberate
  limitation.
* **`exposure`**, a measured weakness that v0 does not fix. It must not fail the run,
  because it is a design choice rather than a bug, but it must be impossible to miss.

The `exposure` kind exists so that a weakness cannot render as `pass`; one that reports
`pass` for a sandbox whose shell can read the injected credential is worse than the
weakness. The three fixed exposures are in §1.2, and the live output is transcribed in
`docs/VERIFICATION.md`.

The probe models the box rather than a fuller one: it injects the variable names the
environment actually has. A box booted with `--no-credential` (§1.3) is probed without any
credential variable, and its exposure line says which remaining secret-looking name is
*not* a provider credential; the native provider's variable is only expected for the
native provider, because a `--base-url` endpoint receives the value under moat's name.
Measured before that: the doctor reported "credential visible to the agent" with
`DEEPSEEK_API_KEY` and `MOAT_INJECTED_CREDENTIAL` for a box that deliberately had neither,
and reported `DEEPSEEK_API_KEY` for a custom endpoint that never has it.

### 7.5 Why not a container runtime

`podman` and `docker` are not installed and cannot be installed (no `sudo`, no
`newuidmap`). Rather than degrade to running the agent on the host, which requirement 2
forbids, moat builds the isolation directly from `unshare`/`mount`/`chroot`, which are
present and work. That is why the launcher is ~200 readable lines instead of a runtime
dependency.

---

## 8. Persistence and snapshots

**Requirement: environments persist per project, with rootfs snapshots, so installs and
caches survive between sessions. Snapshot the rootfs, not the project.**

* The rootfs is reused across boots. `moat down` stops the process; the next `moat up`
  reuses everything, including packages the agent installed. Verified: install a package
  with `moat exec`, then `moat down` and `moat up`, and it is still there
  (`docs/VERIFICATION.md` §persistence).
* `moat snapshot [name]` writes `snapshots/<name>.tar.gz`, a tar of the rootfs with
  `./work`, `./proc`, `./sys`, `./dev`, `./tmp`, `./run` and `./.moat` excluded
  (`sandbox/rootfs.ts:SNAPSHOT_EXCLUDES`). **The project is in none of them.** The name is
  validated (1-64 characters of letters, digits, dot, dash, underscore) before it is
  joined into a path, and the archive is written through a temp file. A snapshot of a
  *running* box can capture a torn state, so `moat snapshot` refuses while a sandbox is
  live unless `--yes` is passed.
* `moat restore <name>` extracts the snapshot beside the live rootfs, carries `/work`
  across with a rename, and swaps the two with renames. If the extraction or the swap
  fails, the previous rootfs and the project are put back; the old version deleted the
  live rootfs first, so one bad snapshot destroyed the environment.
* `baseline` always exists right after provisioning. When the environment came from the
  cached image, `baseline.tar.gz` is a **symlink** to that image rather than a second 107
  MiB compression; the cache file *is* the baseline.
* `moat restore` refuses to run against a live sandbox unless `--yes` is passed, because
  replacing the rootfs underneath a running box would leave it serving a deleted image
  (`cmd/main.ts:cmdRestore`).

`moat up --sync` re-copies the project from the host, discarding the sandbox's working
tree; it warns with the count of commits that exist only inside the sandbox before doing
so.

`moat up --fresh` replaces the rootfs, which deletes `/work` with it. It refuses while a
sandbox is live (the rootfs it is using would be pulled out from under it) and refuses to
delete `/work` that holds unfetched commits or uncommitted files unless `--yes` is passed,
naming the counts first. The pid recorded for a sandbox is reconciled by process start
time, not by number alone, so a reused pid is never signalled.

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

* **No Windows path, no host path.** There is no flag that runs the agent outside the
  sandbox.
* **No session client.** moat does not reimplement the interactive surface: it hands the
  box the terminal and execs Codex's own TUI, so there is no transcript, input line or
  `/command` of moat's own; see §6b.5.
* **No curated tool list.** Codex's tools are the CLI's; moat does not filter, add to or
  patch them, and the box is the bound. See §6.1.
* **No opencode runtime, no fork and no vendored copy.** The server-based runtime is
  deleted rather than kept as a second path, and the CLI that replaced it is a pinned,
  digest-verified binary (`lib/pins.ts`).
* **No proxying of tools.** The agent loop, the tools and the filesystem live inside the
  box; the host is a terminal or a log reader.
* **No `rsync` for git projects.** It cannot represent deletes, renames and symlinks as
  faithfully as git, so it is only the non-git fallback.
* **No secrets in the image, ever.** Enforced by `installCodexFiles` (`bundle/codex.ts`),
  which refuses to write a config or a brief that looks like it carries a literal API key.
