# moat: the contract

moat runs **Pi inside a copied project in a disposable Linux sandbox**. The user reviews the
result and explicitly chooses what to apply to the authoritative host project. The boundary is
moat's box, not a tool permission dialog. This is blast-radius isolation, **not confidentiality**.

The pre-Pi specification is retained in [`archive/SPEC-codex.md`](archive/SPEC-codex.md) as history.
It does not select a runtime or define the current Pi configuration.

## 1. Credentials and trust

### 1.1 What enters the box

The project is copied, never bind-mounted. Host home directories, dotfiles, SSH agents, container
sockets and the host environment are not forwarded. Six device nodes are the only host binds on
the default backend; they are interfaces, bound read-write, not host data. The rootfs is persistent
and agent-controlled, so every host-side read/write there uses the rootfs filesystem guard.

### 1.2 A credential is readable inside the box

A provider key is injected through the process environment, never baked into an image or written
by moat into Pi's `auth.json`, argv, state, configuration or sessions. State records a fingerprint,
source variable names and expiry, not the value. `installPiFiles` checks all rendered files for
recognizable literal keys before writing any. A boot-time rootfs sweep refuses a detected persisted
credential; it is not an exhaustive defense against an agent encoding or hiding a key.

The agent, extensions and project dependencies can read the credential and project. They may send
both to an allowed endpoint. Prefer a provider-scoped, short-lived, spend-capped key. Passing
`--credential VALUE` exposes it in the host's argv/history; prefer `--credential-env NAME`.

### 1.3 Keyless operation

`--no-credential` injects no model key. Compatible local endpoints can run tasks without one; the
moat-managed Pi header hook suppresses the OpenAI SDK's dummy Authorization header. A DeepSeek task
without a credential is refused. No host Pi authentication or OAuth state is imported. Do not put
credentials into project-local Pi configuration or call `/login` if you need environment-only auth:
Pi and extensions can persist credentials themselves, which moat does not promise to prevent.

## 2. Environment and lifecycle

### 2.1 State

State and caches live under `~/.moat` (or `MOAT_HOME`). One environment is identified by the real
project path. It has a persistent Alpine rootfs, `/work`, snapshots, logs and host-owned metadata.
`state.json` is metadata, not the environment: missing state is recovered conservatively from an
existing sandbox repository rather than provisioning over it. Lost host-baseline metadata is not
invented; moat names `--sync` as the way to restore it.

### 2.2 Persistence and replacement

`down` stops the box, preserving work and installed packages. `destroy` deletes the environment
and snapshots and requires confirmation or `--yes`. `up --fresh` deliberately replaces the rootfs
and work: it refuses while a box is alive and requires `--yes` if the box holds unfetched commits
or uncommitted files. All branch/tag tips and detached HEAD count, not just the current branch.
`--sync` explicitly re-copies the host project; ordinary boots keep sandbox work when the host has
moved on and unfetched work exists, with a warning rather than silent loss.

Process identities include `/proc` start times. A reused pid is never signalled as though it were
moat's box. Lifecycle operations wait for an in-flight long boot; status reports booting. Datapath
processes are reaped before their records are cleared. Snapshot restore stages beside the rootfs
and swaps with renames, leaving the live environment intact on extraction failure.

### 2.2b The agent runtime

Pi is the **only** harness. There is no `--runtime` selector, Codex adapter or Claude Code adapter.
Pi, its tools, extensions, MCP processes, configuration and sessions run inside the box. The host
never embeds the Pi SDK to execute agent code. Interactive use attaches Pi's own TUI to a pty;
headless tasks run `pi --mode json` and moat consumes its LF-framed event stream.

Pi's version and complete npm dependency graph are pinned. The lock itself is SHA-256 checked,
every dependency archive is checked against its locked SHA-512 integrity, and no dependency
installation scripts execute on the host. Node and npm are installed inside Alpine even for
non-Node projects. Images are keyed by the Pi version, dependency lock and package set. Existing
Codex/Claude environments and snapshots upgrade in place on their next `up`, preserving `/work`;
missing runtime files are repaired, not a reason to re-provision.

Every boot writes sandbox-local Pi settings, `models.json`, the global `AGENTS.md` brief and the
small keyless-auth hook through the rootfs guard. They contain environment references, not keys.
No instruction file is added to the project. Pi uses its own harness prompt; moat no longer vendors
a Codex prompt or a provider-specific model catalog. Interactive TERM is sanitized and forwarded;
batch boots keep `TERM=dumb`.

Copied `.pi` configuration and resources are trusted with Pi's `--approve`; built-in tools do not
ask for permission. Extensions are executable code and can add tools, ask questions, deny calls,
change models or make extra requests. Their workflow and accounting behavior are not universal
moat guarantees. See [`PI.md`](PI.md) for configuration and compatibility limits.

### 2.2c Spend ceilings

`--max-tokens` bounds reported input + cache hits + output tokens for a headless task. `--max-cost`
requires a known price; otherwise moat warns and carries on. Budgeted tasks run headless even on a
terminal so the host can monitor Pi's stream. These flags do not provide a budget across sessions,
boots or a day, nor an enforceable provider-side limit.

The footer and abort predicate share one parser. Pi's input count already excludes cache reads;
cache writes are counted as input. Reasoning, if reported, is already part of Pi's output and is
split out without double counting. `message_end` is authoritative; deltas and `agent_end` snapshots
are not summed again. Streaming cumulative usage, reported nested-tool usage and compaction usage
are included. A provider that reports usage only at completion cannot be stopped earlier on that
basis. An extension's unreported model calls are not visible. Multi-model work is not priced as
though all tokens came from the configured model.

An exceeded ceiling kills that ephemeral boot and returns nonzero. Model errors/aborts in Pi's
stream also return nonzero even when Pi's process exits zero. `--timeout` is seconds everywhere;
for headless tasks it defaults to 2700, and project checks default to 600.

### 2.3 Boot

Validate flags and host support, claim a boot marker, provision/repair the image if needed, copy or
reuse `/work`, resolve the explicitly configured provider/model, mint the credential, render the
brief/config, then boot the keepalive and verify readiness. The keepalive is not an agent server;
it enforces the credential's own expiry timestamp. Each task, TUI, shell and check gets an ephemeral
boot of the same rootfs. Downloads and cached images are digest checked before extraction.

### 2.4 Commands

| command | contract |
| --- | --- |
| `moat` | Open Pi's TUI in the sandbox; without a terminal print help. Leading up/run flags are accepted. |
| `moat up [task]` | Start/reuse the environment; a terminal task enters Pi's TUI unless headless or budgeted. |
| `moat run "task"` | Same boot path; headless execution reports tools, answers, errors and reported usage. |
| `moat verify` | Run detected project checks inside the box, not on the host. |
| `moat fetch [branch]` | Copy a chosen branch into one `refs/moat/*` ref; never update the host tree or HEAD. |
| `moat take [branch]` | Fetch, classify and offer review; `--json` returns the review/check result without applying. |
| `moat apply` | Review and explicitly write accepted files/hunks; never write a refused conflict. |
| `moat exec -- command` | Execute inside the box, not on the host. |
| `moat shell` | Attach a shell inside the box. |
| `moat down` | Stop, retaining work, packages and snapshots. |
| `moat destroy` | Delete this environment; `--all` skips booting environments with a reason. |
| `moat snapshot [name]` | Save the rootfs, excluding work and pseudo-filesystems. Validate the name before joining paths. |
| `moat restore name` | Restore a staged rootfs while preserving project work; refuse unsafe names/bad archives. |
| `moat status` | Report lifecycle, model, credential expiry, work and measured metadata. |
| `moat logs [name]` | Read guarded, bounded logs; refuse path traversal and invalid tail values. |
| `moat doctor` | Measure isolation and exposures for `open`, `isolated`, `filtered`; prints the count for the mode measured. |
| `moat provider` | Read/write explicit endpoint/model/key-variable configuration, never the key itself. |
| `moat models [provider]` | Show models.dev metadata or configured fallback; refuse an unconfigured provider name. |
| `moat profiles` | List toolchains; database services are opt-in. |
| `moat demo` | Run a keyless scripted Pi task in a scratch project and demonstrate review/apply. |

Unknown flags and flags a command does not read are refused before provisioning. `--help`, `--quiet`
and `--verbose` are global. Human reports go to stderr; machine-readable `--json` goes to stdout.
Sandbox-controlled text printed by host reporting code is stripped of terminal control sequences.
The interactive TUI deliberately controls its attached terminal.

## 3. Copy-in and the baseline

Git projects use `git clone --no-hardlinks`, plus working-tree changes/untracked files. The agent
sees the user's dirty work, but `refs/moat/baseline` records the host **HEAD commit**, not a commit
of that dirty tree. Otherwise an agent could overwrite pre-existing user work as a plain update.
With no HEAD, the baseline is the empty tree. Unborn repositories currently have a known copy-in
limitation: clone brings no initial working tree. Non-git projects use the existing copy fallback
and sandbox repository. Non-UTF-8 filenames are refused explicitly rather than silently dropped.

Host drift is compared against recorded host state. All host-side Git calls against the
agent-controlled repository use `sandboxGit`: execution-capable config, worktree config and
object alternates are neutralized for the duration. Never run raw host Git against `/work` just
because a command looks read-only; signature verification and filters can execute programs too.

## 4. Review and apply

Apply compares baseline, sandbox proposal and current host destination. It classifies agent-only,
user-only, shared and conflicting changes. Content frozen in the plan is applied with explicit
selection: absent means unselected, `[]` none, `null` whole file. Empty acceptance writes nothing.
`--yes` means whole eligible files, not conflict resolution. `--only`, `--skip` and `--hunks` narrow
selection; `--dry-run` writes nothing; `--skip-conflicts` leaves refused paths alone. A file changed
by both sides requires explicit attention; an unresolved conflict is never overwritten.

Hunks are anchored to the host destination; rejected hunks must not reappear. The end-of-file
newline belongs to the accepted ending hunk. Re-plan after a partial write. Git paths are NUL parsed,
merge temps are unique per call/path, binary content never passes through UTF-8 process buffers,
and path guards reject `..` segments/symlink escapes, not ordinary names beginning with dots.

Partial accepts are verified by default against **the current host project plus the accepted
subset**, copied into scratch space inside the rootfs. Reuse copy-in/apply semantics for renames,
deletes, symlinks and binaries. Never check the whole sandbox tree as a substitute. Failure or
timeout writes nothing. `--verify` forces checking; `--no-verify` skips it. No detectable check
means a warning, not a pass. Scaffolding-only echo/test scripts are not real checks.

Fetch/apply warn if the current host credential value is found in copied-out content. The scan
gets the secret through a private patterns file, never argv. It is a warning, not an apply gate;
a rotated/deleted key may no longer be available to scan, and a skipped scan is named.

## 5. Providers

DeepSeek remains the default; a named provider must have been configured with `moat provider add`.
No provider is selected from whichever host key happens to exist. `--base-url` chooses a compatible
endpoint; `--upstream` keeps provider identity while moving its address. Endpoint URLs must be usable
HTTP(S) URLs with hosts. Endpoint, full model id (including slashes), protocol and reasoning effort
persist across boots. `--wire-api responses|chat` selects Responses or Chat Completions explicitly.

One `ModelFacts` record supplies display name, declared limits/capabilities, effort validation and
Pi's model definition. models.dev is optional metadata, not an endpoint/auth selector. Unknown
models still run with their id as the label; undeclared limits are omitted, leaving Pi's own
fallbacks rather than pretending they are provider facts. DeepSeek pricing uses moat's checked
local table, including cache-hit rates and peak hours; other known prices are provider-scoped.

## 6. Pi customization

Project `.pi/extensions`, skills, prompts, themes and trusted settings travel with the copy-in.
They run only inside the sandbox. Host `~/.pi`, auth files, plugins and settings do not travel.
Global moat-managed settings are regenerated each boot; keep project customization in `.pi`.
Pi session history stays under `/root/.pi/agent` by default and survives down/up. Use Pi's own
session, model and thinking controls; moat adds no competing session UI or agent protocol.

Moat disables automatic Pi catalog/update traffic and cache warming. Packages not already installed
may need an explicit in-box `pi install --local`; project network/credential requirements remain
subject to moat's chosen egress policy. Extensions are not a confinement boundary or a spending
broker. See [`PI.md`](PI.md).

## 7. Isolation and networking

### 7.1 Default backend

The current release targets Linux x86-64, including WSL2. Unprivileged user/mount/PID/UTS/IPC
namespaces, chroot and fresh pseudo-filesystems form the box.
Device binds, devpts and mount propagation setup must fail closed. Namespace isolation shares the
host kernel; it is not a microVM. There is no host fallback when namespaces are unavailable.

### 7.2 Egress modes

`open` shares the host network and can reach its services. `isolated` uses its own netns and the
pinned slirp4netns datapath. `filtered` adds an nftables default-deny IP allowlist for provider and
package registries. Every slirp invocation disables host loopback; doctor probes both `127.0.0.1`
and the `10.0.2.2` gateway. New environments default to filtered, except loopback providers default
to open because isolated namespaces intentionally cannot reach them there.

### 7.3 What the default filter does not contain

The agent owns its netns and can flush nftables. Reapplying/re-measuring is detection, not prevention.
The allowlist is a boot-time DNS snapshot, cannot express per-host ports, and DNS remains an outbound
channel. An unresolvable provider fails the long boot; unresolved optional hosts warn. Timed probes
must not report provider reachability when no provider probe was possible.

### 7.4 Opt-in proxy

`--egress-proxy` uses a moat-owned proxy in a separate namespace to enforce exact destination names
and ports. The box has only loopback and a veth to it: no own slirp tap, default route or working
resolver. Every ephemeral boot carries the recorded policy. Readiness waits for the listener, not
merely a visible veth. This requires host `ip(8)` and remains opt-in, not a silent host-dependent
fallback. Allowlisted destinations can still carry out project data or credentials.

### 7.5 Container backend

`--backend container` explicitly chooses rootless podman for the same persistent directory rootfs.
It does not mount the host project or forward credentials differently. The default never requires a
container daemon/runtime. Proxy placement and backend support have explicit limits; moat must not
claim a proxied boot where the selected backend/egress mode cannot carry one.

## 8. Evidence and limitations

[`VERIFICATION.md`](VERIFICATION.md) and its closing **Not verified** table distinguish captured
success from absence of a test. [`TRUST.md`](TRUST.md) is generated from suite outputs. Run the
sandbox suites locally before changing isolation. Current hosted Ubuntu CI runs pass the namespace
suites after capability setup; other runners may refuse, and a skip is not a pass. `CI.md` records
the measured configurations. Never hand-edit captured evidence.

There are no moat-managed CPU/memory/disk quotas, provider-side scoped credentials, aggregate spend
caps, a microVM backend, a universal curated tool list, a proof that an accepted subset is correct,
or a guarantee that arbitrary extensions cannot block or make unreported network calls. Those are
not implications of Pi being configurable, and not claims made by this contract.
