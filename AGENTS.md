# Working on moat

Read this before changing anything. Most of the design here is load-bearing, and
several constraints are not obvious from the code.

## The idea

moat runs an AI coding agent inside a disposable Linux sandbox. The agent gets a
copy of the project, a package manager, a network restricted by default to the
provider and the package registries, and no permission prompts. Everything it can
break is inside the box. Your machine holds the only copy that matters, and
nothing crosses back until you say so.

That is the whole product: **autonomy without prompts**, bought by making the
blast radius a box instead of a home directory.

It is deliberately not a confidentiality boundary. The agent has to read the
project to work on it and has to read the key to call the model, so it has both,
and the default egress allowlist only narrows where it can send them: an
allowlisted address, or DNS, still carries them out. Every claim in the docs is
written to keep that distinction visible rather than to paper over it. If you find
yourself writing "secure" or "safe" without a qualifier, stop.

The direction of travel is a production-ready harness: something you would hand to
a colleague. It is not there yet — see *Where this is going*.

## Invariants

Breaking any of these breaks the product, not a feature.

1. **The host filesystem is never mounted into the sandbox.** The project is
   copied (`git clone --no-hardlinks`), never bind-mounted. The only host
   mounts are six device nodes, bound read-write because a read-only bind makes
   `> /dev/null` fail; they are interfaces, not host data. `moat doctor` prints
   the mount table, root field included.
2. **No credential ever reaches the image.** It is passed as an environment
   variable to the sandbox process, and `bundle/install.ts` refuses to install a
   bundle containing something that looks like a literal key.
3. **`permission: {"*": "allow"}` and nothing else.** No deny rules, ever.
   `bundle/render.ts` asserts this before a config can reach a boot, and the
   plugin re-checks it inside the box.
4. **Copy-out is explicit.** `moat fetch` writes one ref; `moat apply` is a
   separate command. The host tree is provably unchanged until the user says so.
5. **No host environment, SSH agent or dotfiles are forwarded.** `moat doctor`
   diffs the sandbox environment against the host's on every run.
6. **The agent loop, its tools and the filesystem live inside the box.** The host
   is an HTTP client of the server in the sandbox. Nothing is proxied.
7. **No container runtime.** `unshare` + `mount` + `chroot` directly. No Docker,
   no podman, no daemon. This is a constraint, not an accident.
8. **One provider.** DeepSeek. No provider registry, no `--provider`, no
   inference of a provider from the environment. `--base-url` is an escape hatch
   for an OpenAI-compatible endpoint, not the beginning of a provider system.

## Layout

```
cmd/main.ts      the CLI; all UX lives here
cmd/repl.ts      the interactive session
cmd/client.ts    the HTTP client for the sandbox's server
cmd/display.ts   markdown, tool rows, the turn footer — pure functions
sandbox/         rootfs, namespaces, profiles, snapshots, isolation checks
sync/            copy-in and copy-out, and the three-way apply
secrets/         the credential broker and first-run onboarding
bundle/          the rendered opencode config, the plugin, the agent brief
lib/             provider, models.dev catalog, pricing, host probe, hashing
test/            the model stub, the pty suites, and the evidence they write
docs/            SPEC (the contract), VERIFICATION (the evidence),
                 UPSTREAM-CANDIDATES (opencode changes moat would like)
```

## Running it

`node` 22.18+ strips TypeScript types natively, so there is no build step. `moat`
is wired with `npm link` and runs the source directly.

```bash
npm run test:unit         # pure unit tests, no sandbox, so CI runs them
bash test/e2e.sh          # acceptance criteria, ~4 min, no API key
bash test/e2e-extras.sh   # snapshots, apply, credential expiry, the pty suites
bash test/e2e-egress.sh   # netns, slirp datapath, loopback closed, allowlist enforced, default (no key)
DEEPSEEK_API_KEY=... bash test/e2e-live.sh   # a real model, a real task
```

Raw output lands in `test/evidence/`, which is committed and quoted by
`docs/VERIFICATION.md`. Regenerate it by running the suites; do not hand-edit it.

**CI cannot run the sandbox suite.** GitHub's hosted runners cannot create
unprivileged user namespaces — `max_user_namespaces` is fine and AppArmor can be
lifted, but `unshare` is killed by the runner's own confinement. The workflow
reports that as a warning rather than pretending a suite ran. Run the suites
locally before pushing anything that touches `sandbox/`.

## Traps

Things that cost real time. Each of these was hit and diagnosed once already.

**Namespaces**

* `mknod` is denied inside a user namespace. Device nodes are bind-mounted from
  the host instead — those six binds are the only host mounts. They stay
  read-write: remounting them `ro` makes `> /dev/null` fail with EACCES.
* `devpts` fails with `EINVAL` if you pass `gid=5`, because that gid is not mapped
  in a single-id userns.
* `/proc/self/ns/mount` does not exist. The symlink is `mnt`.
* PID 1 ignores default signal dispositions, so a watchdog cannot `kill -TERM 1`.
  The agent runs as a child and the watchdog signals that pid.

**Host-side git**

* The sandbox's repository is agent-controlled, and git executes programs named
  by repository-local config. `core.fsmonitor`, `core.hooksPath`, `filter.*`,
  `diff.external` and aliases all run on the host the moment moat shells out to
  git in `envs/<id>/rootfs/work`. This was verified: `core.fsmonitor = ./x.sh`
  made `moat fetch` run `x.sh` as the user. Every host-side call against that
  repository goes through `lib/git.ts` (`sandboxGit`), which swaps in a minimal
  host-owned config, forces the execution keys off, parks
  `objects/info/alternates`, and restores the agent's config afterwards.
* `log.showSignature` plus `gpg.program` is the same bug with a longer fuse, and it
  was live in the interactive session: `/diff` called `run("git", ["-C",
  options.paths.work, "log", ...])` directly. The global config was nulled, but the
  *repository* config is the agent's, and on a commit carrying any `gpgsig` header
  git runs `gpg.program` — which the agent points at a script it wrote into
  `/work`, whose host path it reads out of `/proc/self/mountinfo`. Measured: the
  script ran as the host user the moment `/diff` was typed; through `sandboxGit` the
  same repository is inert. So: do not add a raw `run("git", ["-C", <…>.work, ...])`
  call. It typechecks, it reviews as ordinary code, and it is no longer only a matter
  of discipline: `test/unit/git-hardening.test.ts` scans the source for that shape
  (`rawWorkTreeGitCalls`) and fails on it. A call that must be raw — `git init`
  before `.git` exists, which the hardened runner refuses to run — carries a
  `raw-git-ok: <reason>` comment on its line or the line above. `repl-diff-hardening.py`
  (extras section X) is the pty proof, and it fails with the raw call back.
* `extensions.worktreeConfig` is deliberately **not** preserved by the config swap, and
  that is load-bearing rather than tidiness: git reads `.git/config.worktree` only while
  that extension is set, so it is the second place the same keys can hide. Dropping the
  extension is what keeps a per-worktree `log.showSignature` + `gpg.program` inert
  (measured with the extension kept: the program runs at repository format version 0
  *and* 1). `test/unit/git-hardening.test.ts` asserts it is dropped and that the
  per-worktree config is not read.
* The sanitized config drops `user.*` like everything else. Any host-side commit
  must pass `GIT_AUTHOR_*`/`GIT_COMMITTER_*` explicitly, as the three commit
  paths in `sync/` already do.
* `moat apply` parses git output with `-z` and merges into one temp file per
  path. Without `-z`, `a  b` parses as `a b` and moat touches the wrong file;
  with one shared temp file, every merge after the first gets the last file's
  content. Both are covered by `test/unit/apply.test.ts`.
* Merge temps are unique per *call* (`partPath`), and cleanup only reaps files
  older than an hour. They were named by path alone and every `planApply` deleted
  every temp it could find, so a plan made while another apply was in flight lost
  its merged inputs under it and `applyPlan` skipped the change without a word.
  `test/unit/apply.test.ts` plans twice and applies the first plan.

**Processes, scripts and logs**

* A pid is not an identity. `state.json` records `pidStart` from
  `/proc/<pid>/stat` when the box is spawned, and `sandboxPidStatus` is the only
  thing that decides whether a recorded pid is safe to signal. Do not call
  `isRunning` on a stored pid; a reused pid would send SIGTERM and SIGKILL to a
  bystander's process group.
* A boot is not instantaneous, and for most of it the environment looks idle:
  state.json still says stopped with no pid, because that is what it said *before*
  the boot started. Measured in that window (provisioning + copy-in + the readiness
  wait): `moat down` printed "sandbox is not running" and the box then came up and
  stayed up, `moat destroy` deleted the rootfs out from under the boot, and a second
  `moat up` booted a second box over the same rootfs — after which state.json records
  whichever finished last and the other sandbox is alive with nothing tracking it.
  The long-running boot now writes `runtime/boot.json` before it starts
  (`sandbox/boot.ts`: pid + start time, reaped as soon as that process is gone), and
  `down`, `destroy`, `restore` and a second `up` wait for it (`awaitBoot`, five
  minutes, then a refusal naming the pid); `snapshot` refuses without `--yes`, and
  `destroy --all` skips a booting environment with a reason instead of blocking.
  Ephemeral boots (`exec`, `doctor`, `shell`, the checks runner) deliberately take
  no marker: running them in parallel is by design. `moat status` says
  `booting (pid N, Ns in)` instead of `stopped` while that marker is live. Extras
  section U polls for the marker rather than sleeping, so the check is not
  timing-based. `test/unit/boot-marker.test.ts` covers liveness, stale pids and the
  wait.
* Boot scripts are unique per invocation (`boot-<pid>-<rand>.sh`,
  `entry-<pid>-<rand>.sh`) and written with write-then-rename, because two host
  processes can boot one environment at once (`moat doctor` while `moat up`, or
  `moat exec` during a restart). `boot.sh` and `entry.sh` are audit copies of
  the most recent boot, not the files that run.
* The long-running box writes its output to `<rootfs>/var/log/moat/boot.log`,
  inside its own rootfs, through a descriptor the host opened and verified (see
  the rootfs traps below). It must not hold an append fd on a host file *outside*
  the box, which is what the old `stdio: [fd, fd]` gave it. `moat logs sandbox`
  and the boot-failure tail read the rootfs file through the guard, capped at
  512 KiB so a log the agent grew cannot exhaust host memory; `logs/sandbox.log`
  only holds the lines before the dup.
* The credential deadline is the credential's **own timestamp**, not the boot's
  start. The host passes `MOAT_CREDENTIAL_EXPIRES_EPOCH`, and the entry script
  checks it before spawning the agent (an already-dead credential must not start
  one) and then sleeps the remaining seconds; the TTL is only the fallback for state
  that predates the variable. Counting the TTL from the script's start let the box
  outlive its key by however long the boot took.
* `--timeout` is **seconds** everywhere (`driveTask` and the checks runner take
  `timeoutSeconds`; the turn default is 2700, the checks runner's is 600). The boot
  readiness wait read it as *milliseconds*, so `moat up --timeout 600` capped the wait
  at 600 ms and failed with "opencode serve did not come up ... after 600ms" — a
  ten-minute budget turned into an instant failure. One flag, one unit: the readiness
  default is 90 seconds.
* The checks runner *took* `timeoutSeconds` from the beginning and **no caller passed
  it**: `moat verify --timeout 1` was accepted and ignored, so a project whose test
  sleeps 3s ran to completion in 3.2s and reported pass. `verify` and `take` pass the
  flag now (measured after the fix: `TIMED OUT after 1s`, exit 124, `FAIL npm test
  1.0s (timed out)`); extras section Y is the check. The REPL's `/verify` has no flag
  and keeps the default.
* The flag layer is `lib/flags.ts`, and it has **two** tables: `SPEC` (every flag moat
  knows, so a typo is refused) and `COMMAND_FLAGS` (what each command actually reads).
  `main()` parses once before dispatch with the command's name, so a flag a command
  does not read is refused with a message naming both. One shared table used to accept
  and silently drop them: that is how `--timeout` never reached the checks runner, and
  how `--quiet` — which every harness in this repo passes — was read by nothing at all,
  while `moat up --help` booted a sandbox instead of printing help.
* When adding a flag: add it to `SPEC`, add it to every command that reads it in
  `COMMAND_FLAGS`, and read it there. `--help`, `--quiet` and `--verbose` are global
  (handled in `main`/the logger) and need no entry. `test/unit/flags.test.ts` fails if
  the table names a flag that does not exist or drops one the suites pass; extras
  section Z covers the refusal, `--quiet` and `--help` end to end.
* A port the host cannot bind is a boot that cannot start, and `--port` was checked for
  *range* but not for availability: an occupied port cost the whole readiness budget
  (90 seconds by default), after provisioning and a copy-in, and failed with
  "opencode serve did not come up (GET /config -> TimeoutError)" — naming neither the
  port nor the reason (the boot log has a bare `ServeError`). `hostPortFree`
  (`lib/port.ts`) is asked up front, against the address the box will actually bind:
  `0.0.0.0` when it has its own network namespace, `127.0.0.1` when it shares the
  host's. `moat up` also says so when `--port` is ignored because the sandbox is
  already running on another one — that used to be silence. Extras section AA is the
  refusal plus the control that the same port boots once it is free;
  `test/unit/port.test.ts` covers the address handling.
* `moat up --fresh` deletes `/work`. It refuses while a sandbox is live and
  refuses without `--yes` when the box holds unfetched commits or uncommitted
  files.
* `state.json` is metadata; the environment is the rootfs. Reading a missing or
  unreadable state as "no environment" made `moat up` provision over the rootfs,
  and provisioning *replaces* it: measured, deleting `state.json` and booting again
  destroyed a committed agent branch and an untracked file, silently, with exit 0 — which
  also contradicts SPEC §2.2 ("`moat destroy` is the only operation that deletes
  data"). `moat up` now recovers the state from disk when `rootfs/work/.git` is
  there (`sandbox/recover.ts`, `recoveredState`), which is also what proves
  provisioning *and* copy-in finished; the credential is not carried over (a new one
  is minted), the recorded host baseline is not invented (the drift check says it
  cannot run and names `--sync`), and an unreadable file is kept as
  `state.json.corrupt-<timestamp>`. `up --fresh` still means replace, gated as before.
  `test/unit/env-recovery.test.ts` guards the reconstruction; extras section T
  deletes the real file and boots again.
* A detected check must be able to fail *and* able to pass. `npm init` scaffolds
  `test: echo "Error: no test specified" && exit 1`, and moat offered it as the
  project's own check: `moat verify` printed FAIL as the project's verdict on work no
  test had looked at, and the agent's brief told it to run that command. An `echo`
  with nothing else is the same problem the other way round (it can only pass).
  `detectChecks` filters both (`isRealScript`); `test/unit/checks-detect.test.ts` and
  extras section W hold it there.
* The agent brief must describe the boot that was actually made, so every claim in it
  is rendered from `InstructionsInput`. Two inputs were declared and never read
  (`hasCredential`, the profile list): a boot against a local endpoint — no credential
  injected — was told to guard a key it did not have, and every boot without
  `--profile db` was told PostgreSQL and Redis were installed and to start them.
  `db` is never auto-detected, and detection never adds it. Adding a claim to the brief
  means rendering it from an input and writing both branches;
  `test/unit/instructions.test.ts` fails if either paragraph goes unconditional again.
* Copy-out scans for the credential it carries, and the value can only come from the
  host: the sandbox stores a fingerprint, never the key. `sync/leak-scan.ts` compares
  against `DEEPSEEK_API_KEY`/`MOAT_CREDENTIAL`/the credential store at fetch/apply time,
  so a key rotated between boot and fetch is invisible to it — that limit is in
  SPEC §4 and in the "Not verified" table, and the scan says when it did not run at all
  (`noteScanSkipped`). The value must never reach argv: `git grep` gets it through a
  0600 patterns file, because every process on the machine can read `ps`. It is a
  warning, not a gate — `moat apply` still writes the file, and extras section AB checks
  both halves (the leak is named; clean content stays quiet).
* `moat restore` stages beside the rootfs and swaps with renames, so a bad
  snapshot cannot destroy the environment. Do not go back to deleting the live
  rootfs first: that is how an afternoon of installed packages and an agent's
  work disappears together.
* Snapshot names meet `path.join` only after `validateSnapshotName`. A raw argv
  join is how `../evil` writes outside `envs/<id>/snapshots`.
* The same rule covers every other argv that becomes a path or a number: `moat logs
  <name>` goes through `validateLogName` (`lib/paths.ts`) — measured, without it
  `moat logs ../../../../../tmp/x` printed `/tmp/x.log`, a host file outside the
  environment — `--tail` through `positiveIntFlag` (a bad value used to mean "the
  whole file"), `--port` validated before provisioning (a typo used to survive the
  copy-in and surface ninety seconds later as "opencode serve did not come up"),
  and `moat models <provider>` checked against the one provider instead of silently
  listing DeepSeek and exiting 0.
* Flags are validated **before provisioning**, because the ones validated at their
  use site fail after the copy-in and read as a boot failure: `--tools` was checked
  in the provider section (after provisioning), and `--log-level` was never checked
  at all — an unknown level fell through `ALLOWED_LOG_LEVELS` in `serveEntryScript`
  and silently became INFO, and a lowercase `--log-level debug` did too.
  `--model ""` and `--base-url ""` booted a config with an empty model id or an empty
  base URL and failed much later. All five now fail in under a second, and the level
  is upper-cased on both sides.

**The agent-controlled rootfs**

* The rootfs is persistent and the agent is root inside it, so **it can replace any
  of its directories with a symlink to a host path**. The host process resolves
  that path on the next boot: measured, with the old code, `installBundle` wrote an
  `AGENTS.md` of 3834 bytes into a directory outside the rootfs — on *every* boot.
  Every host-side write into the rootfs goes through `lib/rootfs-fs.ts`
  (`writeRootfsFile`, `ensureRootfsDir`, `chmodRootfsDir`), which refuses symlinked
  or non-directory components, opens the temp file with `O_EXCL|O_NOFOLLOW`,
  verifies the file it actually opened via `/proc/self/fd`, and renames it into
  place. Do not `fs.writeFileSync(path.join(rootfs, …))` directly; add a helper
  call instead. `test/unit/rootfs-write.test.ts` guards it.
* Reads of agent-controlled files go through `readRootfsFile`, same reason: a
  symlinked `boot.log` or `tools.jsonl` would otherwise print a host file to your
  terminal. Writes *outside* the rootfs (`runtime/boot-*.sh`, `logs/`) are not
  reachable by the agent and stay on plain `writeAtomic`.
* The boot log is opened **on the host** through the same guard and passed to
  the boot script as descriptor 3; the script dups it (`exec 1>&3 2>&3`) instead
  of redirecting to a path. A path resolve in the boot shell would follow a
  symlink planted in the agent-writable rootfs and point the host's write at a
  host directory. `test/unit/rootfs-write.test.ts` asserts the script contains
  the dup and never the path. The lines before the dup still go to
  `logs/sandbox.log` outside the box, which is the fallback when a boot dies
  before it gets that far.
* Text from the sandbox is untrusted **as terminal input**, not only as data. The
  answer, the reasoning, commit subjects, branch names, change paths, session titles
  and the boot log all come from inside the box, and a terminal acts on the escape
  sequences in them: OSC 0 retitles the window, OSC 52 writes the clipboard where
  the terminal allows it, CSI 2J clears the screen, and a carriage return overwrites
  the row — enough to repaint the transcript the user is reading, which is exactly
  what a prompt injection wants. Tool output and tool titles were already stripped
  (`stripAnsi` in `cmd/display.ts`); the model's own words and most of the sandbox
  metadata were not. Every such site now strips at the print boundary, and
  `AnswerRenderer` strips per delta — safe against a sequence split across two
  deltas, because `stripAnsi` removes every ESC byte (as a sequence *or* as a
  control character), so nothing can be reassembled on screen. Do not print a string
  that came out of the sandbox without it: paths, refs and subjects included.
  `test/unit/terminal-text.test.ts`, `test/repl-escapes.py` and extras section V hold
  it there (4 of the 7 pty checks fail with `stripAnsi` made a no-op).
* Snapshot extraction needs no guard of its own, and that was measured rather than
  assumed: GNU tar refuses to write through a symlink its own archive created
  (`Cannot open: Not a directory`, target untouched), and `restoreEnv` treats a
  non-zero tar exit as a failed restore and rolls back.
* `apk` trusts its database over the filesystem. Deleting `/usr/sbin/nft` without
  touching apk's records leaves `apk add nftables` with nothing to do, so
  `ensurePackages` has a `resetFirst` mode (`apk del` the entry, then install) and
  `ensureFilterTool` uses it when the binary is still missing after a normal
  install. That is how the bug was found: the e2e check deletes the binary and the
  boot then failed with "this image has none".

**Downloads and caches**

* Every network artefact is checked against a digest pinned in `lib/pins.ts`
  (Alpine's release SHA-256, the opencode npm tarball's `dist.integrity`) through
  `verifyFile` before anything unpacks it, and an already-cached file is
  re-checked. Do not add a download path that skips this.
* Temp files are named with `partPath()`: pid **and** a random suffix. A pid
  alone collided for two concurrent downloads in one process, and the loser's
  rename failed; write-then-rename is what makes the cache safe to share.
* The provisioned image cache carries a `.sha256` sidecar written when it was
  built; a mismatch rebuilds the image instead of unpacking it.

**Egress and the datapath**

* slirp4netns has no command-line port forwarding. Host-to-sandbox ports go
  through its API socket (`-a/--api-socket`): connect and send
  `{"execute":"add_hostfwd",...}`. Its replies are one JSON object with **no**
  trailing newline, and the socket appears asynchronously after spawn, so the
  RPC client waits for the path and parses the accumulated buffer instead of
  reading lines. Getting any of that wrong looks like a hang or an ENOENT.
* Always pass `--disable-host-loopback`. Without it slirp's 10.0.2.2 gateway
  forwards straight to the host's loopback: measured HTTP 200 for a host service
  from inside the "isolated" namespace. `moat doctor` probes **both**
  `127.0.0.1` and `10.0.2.2`, because testing only the namespace's own loopback
  is vacuous and passes while the hole is open.
* In any own-namespace mode (both `isolated` and `filtered`) `opencode serve`
  binds `0.0.0.0`; a loopback bind inside the namespace cannot be reached through
  the forward. The predicate for "has its own namespace" lives in one place,
  `ownNetns()` in `lib/pins.ts`, because `filtered` was once spelled
  `opts.egress === "isolated"` at four call sites: the box then booted in the
  **host's** namespace and `nft -f` failed with `netlink: Error: cache
  initialization failed: Operation not permitted` (nft needs `CAP_NET_ADMIN` in
  the namespace's user namespace and an unprivileged user has none in the host's).
  `bootIsolation()` now refuses to boot a ruleset outside the sandbox's own
  namespace, and `test/unit/egress.test.ts` fails if either predicate regresses.
* slirp's API socket has a **one-connection accept queue**. The readiness probe
  opens a connection and destroys it, and the forward's own connect can then fail
  with `EAGAIN` while the probe is still queued (measured on a real boot: "connect
  EAGAIN" on a boot that succeeded on the next attempt). `addHostForward` retries
  a connect that never reached slirp, and treats a *reply* that refuses the forward
  as final. `pruneDeadSockets` is conservative for the same reason: only ENOENT or
  ECONNREFUSED unlinks a socket file, because EAGAIN is what a live socket looks
  like from here, and unlinking a live one makes it unreachable by path for the
  rest of its life.
* The API socket is **not** a fixed path. Every boot names its own
  (`slirp-<pid>-<rand>.sock`) and readiness is a **connection**, not a `stat()`:
  a socket file outlives the slirp that made it, so a restart that only checked
  `existsSync` found the previous boot's corpse (`ECONNREFUSED` from the forward,
  and slirp itself cannot bind over a stale file). `pruneDeadSockets` reaps the
  ones nothing is listening on and never touches a live one.
* The in-box connectivity probes are wrapped in `timeout`: a default-deny policy
  **drops** packets, and an unbounded `/dev/tcp` connect sits in the kernel's SYN
  retries for about two minutes before reporting the failure it already knows
  about. `moat doctor` in filtered mode is the case that hits it.
* **The filter is not a jail.** The sandbox owns its netns, so uid 0 inside holds
  `CAP_NET_ADMIN` there. Measured: `nft flush ruleset` inside a filtered box exits
  0 and `curl https://1.1.1.1/` then answers 301, where it had timed out before.
  Every boot re-applies the ruleset and `moat doctor` re-measures it, so this is
  detected on the next run, never prevented. Do not describe the policy as
  containment; SPEC §7.3 says what it does buy.
* An allowlist host that does not resolve is dropped from the ruleset. Fine for an
  extra registry, fatal for the provider: a filtered box with no provider address
  boots happily and fails only when the agent calls the model. `moat up` fails with
  "could not resolve <host>" and names the way out, other unresolved hosts are a
  warning, and ephemeral boots warn rather than fail (`moat exec` may be the
  diagnosis). `resolveAllowlistDetailed` reports the failures; `resolveAllowlist`
  is the addresses-only wrapper.
* A provider URL has to be **usable**, not merely parseable. `new URL()` accepts
  `localhost:11434/v1` — the scheme-less form of the endpoint moat's own error text
  suggests — as protocol `localhost:` with an empty hostname, and everything
  downstream reads `.hostname`: `providerHost()` puts no provider in the filtered
  allowlist, `providerProbe()` hands the doctor no endpoint, and
  `reportUnresolved(…, undefined, true)` has nothing to fail on. Measured: `moat up`
  booted filtered with no provider address (exit 0, ready in 13s) and `moat doctor`
  printed "the provider is reachable" for a probe it never ran. `checkBaseUrl`
  (`lib/provider.ts`) runs before provisioning for both `--base-url` and
  `--upstream`; `filteredEgressCheck` (`sandbox/isolation.ts`) says the check is
  one-sided rather than claiming a probe that did not happen. Extras section AC is the
  refusal plus the control; `test/unit/base-url.test.ts` and
  `test/unit/doctor-egress.test.ts` hold both halves.
* A project file name that is not valid UTF-8 is refused by `assertAddressableNames`
  (lib/fs-names.ts) at the start of `copyIn` and `hashTree`, naming the bytes. Node
  decodes such a name to U+FFFD, which is not the name on disk, so the next `lstat`
  reports ENOENT for a file that is right there (measured: `hashTree` on
  `bad\xffname`). Supporting them means Buffer paths through every host-side walk
  (hashing, the untracked-file pass, apply's tree reads); that does not exist yet,
  and pretending otherwise would drop files silently.
* A filtered boot needs `nft` inside the image, and *every* path that boots one
  has to ensure it (`ensureFilterTool` in `cmd/main.ts`), not just `moat up`. An
  environment restored from a snapshot taken before nftables was baked in used to
  fail `doctor` and `exec` with "[moat] failed to apply the egress policy", which
  reads like a moat bug rather than a missing package.
* The long-running box records its slirp pid in `state.json` and `moat down`
  stops it after the box (its start time is checked, like the sandbox pid).
  Ephemeral boots (doctor, exec, checks, shell) start their own slirp with a
  unique API socket, so they run in the same kind of network as the box rather
  than quietly measuring a different one.

**opencode 1.18.31**

* The model-facing argument for file tools is `filePath`, not `path`. opencode's
  internal schemas say `path`; the schema it shows the model renames it. A guard
  checking the wrong spelling matches nothing and confines nothing, silently.
* Streamed text arrives as `message.part.delta`, **not** as a `delta` field on
  `message.part.updated`. Reading the wrong one renders tool calls and no answers.
* The SDK's event stream **reconnects forever and never ends**.
  `event.subscribe` goes through the generated SSE client
  (`@opencode-ai/sdk/dist/gen/core/serverSentEvents.gen.js`), whose loop is
  `while (true)`: a failed connection calls `onSseError`, sleeps with backoff (up
  to 30s) and tries again, indefinitely. It neither throws nor ends the
  generator, so a box stopped mid-turn looks exactly like a quiet one. Measured
  in a pty: `moat attach`, a turn in flight, `moat down` — and the REPL sat there
  with its spinner up, answering every later line with "queued — the agent will
  pick this up when the current step finishes" for a turn that was already over.
  Both subscribe sites pass `sseMaxRetryAttempts: 1` (one attempt, no reconnect)
  and an `onSseError` handler, which turns the failure into an *end* the consumer
  can see: the REPL reports that the live view is gone and refuses to send, and
  `moat run` records "the event stream ended mid-turn" instead of returning the
  partial transcript as a finished turn. Do not remove those options: without
  them a consumer waits for a `session.idle` that can never arrive. Not covered:
  a stream that stays open and simply goes quiet — no FIN, no error — which
  nothing observed produces (a box that dies closes its sockets), and for which
  there is no silence watchdog.
* An unknown reasoning variant is *ignored*, not rejected. Never hardcode the
  levels: read them from `GET /config/providers` per model.
* `GET /config/providers` returns a `default` field that is opencode's own notion
  of the provider's preferred model and has nothing to do with moat's config. The
  effective model is `model` in `GET /config`.
* The `shell.env` hook is an overlay, so `delete`ing a key does nothing. Secret
  names are overridden to `""` instead.
* Plugin hook names are `permission.ask` (not `permission.asked`). Verified
  against `packages/plugin/src/index.ts`, not from memory.
* The bundle is reinstalled on **every** boot. A cached image serving a stale
  plugin is a bug that already happened once.
* opencode compiles `tools: {name: false}` into `permission: {name: "deny"}`
  *before* the plugin's `config` hook runs (`config/config.ts`, "if
  (result.tools)"), and a hook that throws is logged and **ignored** — the boot
  carries on. So a throwing hook is a silent loss: the in-box invariant check
  rejected every boot for several commits and the only symptom was an ERROR line
  in a boot log nobody read, while its audit `config` record never appeared.
  Write checks in that hook against the merged config, and treat "the hook threw"
  as something the evidence has to show (`test/unit/plugin-guard.test.ts` asserts
  the record is written when the check passes).
* Requirement 4 — advertising exactly the curated tool set — is **not achievable**
  in 1.18.31. The bundle refuses to *execute* anything outside the curated set
  instead. `moat tools` prints the gap. Do not "fix" this by hiding the gap.

**Pipes and encodings**

* `run()` in `lib/shell.ts` captures a child's stdout as a UTF-8 **string**. That
  is wrong for anything binary. Piping a tar archive through it corrupted the
  archive, because a byte that is not valid UTF-8 becomes U+FFFD and re-encodes
  to three bytes — the stream grows, every later header is read from the wrong
  offset, and tar stops partway. This silently broke `moat apply` on any project
  containing a binary file. Binary data goes through a **file**, not through this
  process.
* A child that exits before its input is fully written closes the pipe, and Node
  raises EPIPE on the stdin socket. With no `error` listener that is an unhandled
  event and it kills the process. `run()` swallows EPIPE deliberately: the child's
  exit code is the thing worth reporting.

**DeepSeek**

* models.dev prices are wrong for `deepseek-v4-pro`, and it has no notion of peak
  hours, which double every rate. `lib/pricing.ts` holds the published table.
* In opencode's token accounting, `input` is the cache-**miss** count and
  `cache.read` is the hit count. `reasoning` is billed at the output rate as a
  field separate from `output`.
* `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are retired names served
  by the current Flash model. `deepseek-flash` is the current name.

**This codebase**

* SPEC is the contract, so it must not carry a count the tool prints. The
  `moat doctor` row promised "15 isolation assertions" while the three egress modes
  print 14 (`open`), 16 (`isolated`) and 17 (`filtered`) — and the command prints the
  count itself. Nothing kept the number honest. Counts belong in the capture
  (`docs/VERIFICATION.md` §4b) and in the tool's own output, not in a hand-maintained
  table; `test/unit/docs-claims.test.ts` fails if that row states a count again.
* Node's type stripping cannot desugar TypeScript parameter properties
  (`constructor(private readonly x: T)`). Use plain fields. `tsconfig` sets
  `erasableSyntaxOnly`, so this fails at typecheck.
* The published SDK's generated types lag the server in several places
  (`variant` on the prompt body, `variants` on a model). Return such objects from
  a function rather than writing them as inline literals, and TypeScript stops
  complaining — it only rejects unknown properties on fresh literals.

## What is verified, and what is not

`docs/VERIFICATION.md` is the authority, and it is deliberately organised so that
absence is not mistaken for success. Read its closing table before claiming
anything works.

Two rules the suite follows, worth preserving:

* **Assert on the thing, not on moat's account of the thing.** `test/wire-effort.py`
  reads the actual request body through a recording proxy rather than asking
  opencode which variant it recorded.
* **A check that cannot fail is not a check.** When adding a regression guard,
  reintroduce the bug and watch it fail before trusting it.

## Where this is going

Not built, in rough order of how much they matter:

* **Egress policy, second half.** Done: a new environment gets its own network
  namespace, the pinned slirp4netns datapath, a closed host loopback on both
  routes, and an nftables default-deny allowlist resolved at boot, with
  `bash test/e2e-egress.sh` proving the allowed and the blocked path without a
  key and `moat doctor` failing the run when either is wrong. What is left is the
  allowlist's shape rather than its existence: it is an IP snapshot taken at boot
  (a rotating CDN address falls out until the next `moat up`), it cannot express
  per-host ports, and DNS to slirp's resolver remains an outbound channel. Closing
  those means a resolving proxy moat owns, not a bigger ruleset.
* **Provider-side credential scoping** — short-lived, spend-capped tokens minted
  per boot, instead of borrowing a long-lived key.
* **Cost ceilings.** The turn footer reports what a turn cost; nothing stops it.
* **v1: a microVM.** The current isolation is namespaces, which is v0. `/dev/kvm`
  exists on this host but is not accessible to the user.
* **Byte paths for file names that are not valid UTF-8.** `assertAddressableNames`
  refuses them today with a clear message instead of an ENOENT for a file that
  exists; supporting them means Buffer paths through hashing, the untracked-file
  pass and apply's tree reads, plus a digest encoding that keeps today's hashes for
  UTF-8 names.
* **Exact tool advertisement**, which needs an upstream change (see
  `docs/UPSTREAM-CANDIDATES.md`).

If you are picking this up: the sandbox, the copy-in/copy-out and the credential
broker are the parts that matter and they are done. The agent runtime is
opencode's, reached through thirteen HTTP calls. Treat that boundary as the seam
to change things at.
