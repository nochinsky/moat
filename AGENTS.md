# Working on moat

Read this before changing anything. Most of the design here is load-bearing, and several
constraints are not obvious from the code.

If you are working through the product program rather than a one-off change, that is
`docs/PROGRAM.md`: gated phases, a status page at `docs/PROGRESS.md`, the session record
it points to, and a list of reported defects to confirm before fixing. This file stays the
contract; that one says what to build next.

## The idea

moat runs an AI coding agent inside a disposable Linux sandbox. The agent gets a copy of
the project, a package manager, a network restricted by default to the provider and the
package registries, and no permission prompts. Everything it can break is inside the box;
your machine holds the only copy that matters, and nothing crosses back until you say so.

That is the whole product: **autonomy without prompts**, bought by making the blast radius
a box instead of a home directory.

It is deliberately not a confidentiality boundary. The agent has to read the project to
work on it and has to read the key to call the model, so it has both, and the default
egress allowlist only narrows where it can send them: an allowlisted address, or DNS,
still carries them out. Every claim in the docs keeps that distinction visible. If you
find yourself writing "secure" or "safe" without a qualifier, stop.

The direction of travel is a production-ready harness, something you would hand to a
colleague. It is not there yet; see *Where this is going*.

## Invariants

Breaking any of these breaks the product, not a feature.

1. **The host filesystem is never mounted into the sandbox.** The project is copied
   (`git clone --no-hardlinks`), never bind-mounted. The only host mounts are six device
   nodes, bound read-write because a read-only bind makes `> /dev/null` fail; they are
   interfaces, not host data. `moat doctor` prints the mount table, root field included.
2. **No credential ever reaches the image.** It is passed as an environment variable to
   the sandbox process, and `installCodexFiles` (`bundle/codex.ts`) refuses to write a
   config or a brief that looks like it carries a literal key.
3. **The agent never asks for approval and never gets a second
   sandbox.** `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` are
   rendered by moat on every boot, in one file the agent does not own. moat's box is the
   boundary; a weaker one next to it is worse than none.
4. **Copy-out is explicit.** `moat fetch` writes one ref; `moat apply` is a separate
   command. The host tree is provably unchanged until the user says so.
5. **No host environment, SSH agent or dotfiles are forwarded.** `moat doctor` diffs the
   sandbox environment against the host's on every run.
6. **The agent loop, its tools and the filesystem live inside the box.** The host is a
   terminal and a log reader: it hands the box a pty, or reads the CLI's own event stream.
   There is no server in the box and nothing is proxied.
7. **No container runtime.** `unshare` + `mount` + `chroot` directly. No Docker, no podman,
   no daemon. This is a constraint, not an accident.
8. **No provider registry, and no guessing.** DeepSeek is the default provider; a *named* one
   is configuration the user wrote down (`moat provider add`, `--provider <id>`), never inferred
   from the environment, and an unconfigured name is refused. `--base-url` remains an escape
   hatch for an OpenAI-compatible endpoint rather than the beginning of a provider system.
   *(Amended by Phase 1 of `docs/PROGRAM.md`, which instructs this unlock by name. The original
   invariant was "One provider. DeepSeek." — the discipline about not guessing is what survives,
   and `test/unit/provider-security.test.ts` holds it. `docs/SPEC.md` §5 carries the same
   amendment and the reasoning.)*

## Layout

```
cmd/main.ts      the CLI; all UX lives here
sandbox/         rootfs, namespaces, profiles, snapshots, isolation checks
sync/            copy-in and copy-out, and the three-way apply
secrets/         the credential broker and first-run onboarding
bundle/          the rendered Codex config, the agent brief, the event parser
lib/             provider, models.dev catalog, pricing, host probe, hashing
stub/            the keyless model stub and its scripts — runtime, not test, because
                 `moat demo` ships them and a published package cannot reach into test/
test/            the pty suites, the fixtures, and the committed evidence they write
docs/            SPEC (the contract), VERIFICATION (the evidence),
                 HISTORY (how the project got here), SEAM (the interface a second
                 runtime would have to satisfy), PROGRESS (where things stand),
                 archive/ (the build journal, closed phases only)
```

## Packaging

`npm pack` / `npm publish` run `npm run build` first (`prepack`) and ship **`dist/`**, not the
sources, because **Node refuses to strip TypeScript types inside `node_modules`** — a published
package that points `bin` at a `.ts` file installs fine and dies on first run with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. That is measured, not theoretical: it is what the
first tarball here did. `npm run build` is therefore the *only* build step in the project, and it
exists solely for the tarball; development still runs the sources directly.

Two layout traps come with it, both found by installing the tarball and running it:

* **The package root is not a fixed number of levels up.** Source is `<root>/cmd/main.ts`;
  the compiled build is `<root>/dist/cmd/main.js`. `lib/paths.ts` exports `PACKAGE_ROOT`, which
  walks upward for the package's own `package.json`, and `cmd/main.ts` (the version line) and
  `cmd/demo.ts` (the stub and the CLI it spawns) read through it. Do not reintroduce
  `path.join(import.meta.dirname, "..", ...)`.
* **A runtime asset under `test/` is invisible to the published package**, because `test/` is
  not shipped. `moat demo` used to read `test/mock-responses.mjs` and
  `test/scripts/responses-demo.json`; both now live in `stub/`, which `files` includes. When
  adding an asset a *command* reads, put it where `files` ships and check `npm pack` lists it.

The npm name is `moat-sandbox`. Both `moat` and `moat-cli` belong to unrelated packages, so
`npx moat` and `npx moat-cli` fetch the wrong thing; the installed **command** is `moat`.

## Releasing

A release is a tag. `.github/workflows/release.yml` runs on `v*`, typechecks, runs the unit
suites, refuses a tag that disagrees with `package.json`, and publishes with provenance over
GitHub's OIDC identity. **There is no npm token anywhere**, on purpose: npm restricted
2FA-bypass tokens for direct publishing during this project, so a stored secret stops working
precisely when an account has 2FA on. `0.0.1` was published through the browser flow before
this existed.

```bash
npm version patch --no-git-tag-version   # edits package.json only
git commit -am "0.0.2: ..."
git tag v0.0.2 && git push origin main v0.0.2
```

One-time setup, in the npm web UI rather than here: npm has to be told which repository and
workflow may publish, at `https://www.npmjs.com/package/moat-sandbox/access`. Until that
publisher exists the workflow fails at the publish step with an authentication error.

The version in `package.json` and the tag must match, and a published version can never be
reused — not even after `npm unpublish`. When in doubt, bump rather than retry.

## Running it

`node` 22.18+ strips TypeScript types natively, so **development** has no build step. `moat` is
wired with `npm link` and runs the source directly. The one build that exists is for the
published tarball — see *Packaging* above.

```bash
npm run test:unit         # pure unit tests, no sandbox, so CI runs them
bash test/e2e-codex.sh    # the acceptance list, against a keyless model stub
bash test/e2e-extras.sh   # snapshots, apply, credential expiry, state and process traps
bash test/e2e-egress.sh   # netns, slirp datapath, loopback closed, allowlist enforced, default (no key)
bash test/e2e-provider.sh # a named, non-DeepSeek provider end to end, no credential in the image
bash test/e2e-demo.sh     # `moat demo`: three-way attribution, keyless
bash test/e2e-review.sh   # the review surface: per-hunk attribution, a partial accept
DEEPSEEK_API_KEY=... bash test/e2e-live.sh   # a real model, a real task
```

Raw output lands in `test/evidence/`, which is committed and quoted by
`docs/VERIFICATION.md`. Regenerate it by running the suites; do not hand-edit it.

**CI cannot run the sandbox suite.** GitHub's hosted runners cannot create unprivileged
user namespaces: `max_user_namespaces` is fine and AppArmor can be lifted, but `unshare`
is killed by the runner's own confinement. The workflow reports that as a warning rather
than pretending a suite ran. Run the suites locally before pushing anything that touches
`sandbox/`.

## Traps

Things that cost real time. Each of these was hit and diagnosed once already.

**Namespaces**

* `mknod` is denied inside a user namespace, so device nodes are bind-mounted from the
  host; those six binds are the only host mounts. They stay read-write: remounting them
  `ro` makes `> /dev/null` fail with EACCES. **Never add `|| true` to one of those binds,
  or to the devpts mount or the `--make-rprivate`:** a swallowed failure leaves a regular
  file where the device should be, and the box writes its output into its own rootfs while
  `> /dev/null` reports success. The boot checks each one (`[ -c ... ]`, `mountpoint -q`)
  and refuses; `moat doctor` re-measures it as **device nodes are real devices**.
* `devpts` fails with `EINVAL` if you pass `gid=5`, because that gid is not mapped in a
  single-id userns.
* `/proc/self/ns/mount` does not exist. The symlink is `mnt`.
* PID 1 ignores default signal dispositions, so a watchdog cannot `kill -TERM 1`. The
  agent runs as a child and the watchdog signals that pid.

**Host-side git**

* The sandbox's repository is agent-controlled, and git executes programs named by
  repository-local config. `core.fsmonitor`, `core.hooksPath`, `filter.*`, `diff.external`
  and aliases all run on the host the moment moat shells out to git in
  `envs/<id>/rootfs/work`. Verified: `core.fsmonitor = ./x.sh` made `moat fetch` run
  `x.sh` as the user. Every host-side call against that repository goes through
  `lib/git.ts` (`sandboxGit`), which swaps in a minimal host-owned config, forces the
  execution keys off, parks `objects/info/alternates`, and restores the agent's config
  afterwards.
* `log.showSignature` plus `gpg.program` is the same bug with a longer fuse, and it was
  live in the interactive session: `/diff` called
  `run("git", ["-C", options.paths.work, "log", ...])` directly. The global config was
  nulled, but the *repository* config is the agent's, and on a commit carrying any
  `gpgsig` header git runs `gpg.program`, which the agent points at a script it wrote into
  `/work`, whose host path it reads out of `/proc/self/mountinfo`. Measured: the script
  ran as the host user the moment `/diff` was typed; through `sandboxGit` the same
  repository is inert. Do not add a raw `run("git", ["-C", <...>.work, ...])` call: it
  typechecks, it reviews as ordinary code, and `test/unit/git-hardening.test.ts` scans the
  source for that shape (`rawWorkTreeGitCalls`). A call that must be raw (`git init`
  before `.git` exists, which the hardened runner refuses to run) carries a
  `raw-git-ok: <reason>` comment on its line or the line above. The source scan is the
  guard.
* `extensions.worktreeConfig` is deliberately **not** preserved by the config swap, and
  that is load-bearing: git reads `.git/config.worktree` only while that extension is set,
  so it is the second place the same keys can hide. Dropping the extension keeps a
  per-worktree `log.showSignature` + `gpg.program` inert (measured with the extension
  kept: the program runs at repository format version 0 *and* 1).
  `test/unit/git-hardening.test.ts` asserts it is dropped and that the per-worktree config
  is not read.
* The sanitized config drops `user.*` like everything else. Any host-side commit must pass
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*` explicitly, as the three commit paths in `sync/` do.
* `moat apply` parses git output with `-z` and merges into one temp file per path. Without
  `-z`, `a  b` parses as `a b` and moat touches the wrong file; with one shared temp file,
  every merge after the first gets the last file's content. Both are covered by
  `test/unit/apply.test.ts`.
* Merge temps are unique per *call* (`partPath`), and cleanup only reaps files older than
  an hour. They were named by path alone and every `planApply` deleted every temp it could
  find, so a plan made while another apply was in flight lost its merged inputs under it
  and `applyPlan` skipped the change without a word. `test/unit/apply.test.ts` plans twice
  and applies the first plan.
* **`moat apply`'s selection map holds three states, and a `??` default collapses two of
  them.** `null` is "the whole file", `[]` is "none of it", and *absent* is "not selected".
  `chosen.get(path) ?? null` made an absent path mean the whole file — rejecting everything
  applied everything — and the reverse fix, `?? []`, is worse in a quieter way: it answers
  `[]` for a `null` value too, so "the whole file" becomes unreachable and `--yes` stops
  writing anything. `applySelection` therefore reads the map with no default and tests
  `chosen.has` explicitly. Measured: deleting the `has` guard fails
  `accepting nothing writes nothing at all` in `test/unit/review.test.ts`, because the unselected
  path then reaches the `?? null` default and is written in full.
* **A partial accept makes a plan stale for the same file.** The plan's hunks are computed
  against the destination *as it is*, so after one hunk is written, re-applying the same
  plan to the same path is not idempotent — `moat apply` re-plans each time, and a caller
  holding an `ApplyPlan` across a write must plan again. Related, same function: hunks are
  anchored to the **destination**, not the source. Anchoring a merge to the merged bytes
  made a *rejected* hunk come back on the next apply, because the merged content already
  contains every hunk; anchoring to your file is what makes rejection stick, and
  `test/unit/review.test.ts` fails if that regresses.

**Processes, scripts and logs**

* A pid is not an identity. `state.json` records `pidStart` from `/proc/<pid>/stat` when
  the box is spawned, and `sandboxPidStatus` is the only thing that decides whether a
  recorded pid is safe to signal. Do not call `isRunning` on a stored pid; a reused pid
  would send SIGTERM and SIGKILL to a bystander's process group.
* A boot is not instantaneous, and for most of it the environment looks idle: state.json
  still says stopped with no pid, because that is what it said *before* the boot started.
  Measured in that window (provisioning + copy-in + the readiness wait): `moat down`
  printed "sandbox is not running" and the box then came up and stayed up, `moat destroy`
  deleted the rootfs out from under the boot, and a second `moat up` booted a second box
  over the same rootfs, after which state.json records whichever finished last and the
  other sandbox is alive with nothing tracking it. The long-running boot now writes
  `runtime/boot.json` before it starts (`sandbox/boot.ts`: pid + start time, reaped as
  soon as that process is gone), and `down`, `destroy`, `restore` and a second `up` wait
  for it (`awaitBoot`, five minutes, then a refusal naming the pid); `snapshot` refuses
  without `--yes`, and `destroy --all` skips a booting environment with a reason instead
  of blocking. Ephemeral boots (`exec`, `doctor`, `shell`, the checks runner) deliberately
  take no marker: running them in parallel is by design. `moat status` says
  `booting (pid N, Ns in)` instead of `stopped` while that marker is live. Extras section
  U polls for the marker rather than sleeping, so the check is not timing-based.
  `test/unit/boot-marker.test.ts` covers liveness, stale pids and the wait.
* Boot scripts are unique per invocation (`boot-<pid>-<rand>.sh`, `entry-<pid>-<rand>.sh`)
  and written with write-then-rename, because two host processes can boot one environment
  at once (`moat doctor` while `moat up`, or `moat exec` during a restart). `boot.sh` and
  `entry.sh` are audit copies of the most recent boot, not the files that run.
* The long-running box writes its output to `<rootfs>/var/log/moat/boot.log`, inside its
  own rootfs, through a descriptor the host opened and verified (see the rootfs traps
  below). It must not hold an append fd on a host file *outside* the box, which is what
  the old `stdio: [fd, fd]` gave it. `moat logs sandbox` and the boot-failure tail read
  the rootfs file through the guard, capped at 512 KiB so a log the agent grew cannot
  exhaust host memory; `logs/sandbox.log` only holds the lines before the dup.
* The credential deadline is the credential's **own timestamp**, not the boot's start. The
  host passes `MOAT_CREDENTIAL_EXPIRES_EPOCH`, and the entry script checks it before
  spawning the agent (an already-dead credential must not start one) and then sleeps the
  remaining seconds; the TTL is only the fallback for state that predates the variable.
  Counting the TTL from the script's start let the box outlive its key by however long the
  boot took.
* `--timeout` is **seconds** everywhere (`runCodexTask` and the checks runner take
  `timeoutSeconds`; the turn default is 2700, the checks runner's is 600). One caller read
  it as *milliseconds*, so a ten-minute budget became an instant failure, measured as a
  boot that gave up after 600 ms. One flag, one unit.
* The checks runner *took* `timeoutSeconds` from the beginning and **no caller passed
  it**: `moat verify --timeout 1` was accepted and ignored, so a project whose test sleeps
  3s ran to completion in 3.2s and reported pass. `verify` and `take` pass the flag now
  (measured after the fix: `TIMED OUT after 1s`, exit 124,
  `FAIL npm test 1.0s (timed out)`); extras section Y is the check.
* The flag layer is `lib/flags.ts`, with **two** tables: `SPEC` (every flag moat knows, so
  a typo is refused) and `COMMAND_FLAGS` (what each command actually reads). `main()`
  parses once before dispatch with the command's name, so a flag a command does not read
  is refused with a message naming both. One shared table used to accept and silently drop
  them: that is how `--timeout` never reached the checks runner, and how `--quiet`, which
  every harness in this repo passes, was read by nothing at all, while `moat up --help`
  booted a sandbox instead of printing help.
* When adding a flag: add it to `SPEC`, add it to every command that reads it in
  `COMMAND_FLAGS`, and read it there. `--help`, `--quiet` and `--verbose` are global
  (handled in `main`/the logger) and need no entry. `test/unit/flags.test.ts` fails if the
  table names a flag that does not exist or drops one the suites pass; extras section Z
  covers the refusal, `--quiet` and `--help` end to end.
* `moat up --fresh` deletes `/work`. It refuses while a sandbox is live and refuses
  without `--yes` when the box holds unfetched commits or uncommitted files.
* `state.json` is metadata; the environment is the rootfs. Reading a missing or unreadable
  state as "no environment" made `moat up` provision over the rootfs, and provisioning
  *replaces* it: measured, deleting `state.json` and booting again destroyed a committed
  agent branch and an untracked file, silently, with exit 0, which also contradicts SPEC
  §2.2 ("`moat destroy` is the only operation that deletes data"). `moat up` now recovers
  the state from disk when `rootfs/work/.git` is there (`sandbox/recover.ts`,
  `recoveredState`), which is also what proves provisioning *and* copy-in finished; the
  credential is not carried over (a new one is minted), the recorded host baseline is not
  invented (the drift check says it cannot run and names `--sync`), and an unreadable file
  is kept as `state.json.corrupt-<timestamp>`. `up --fresh` still means replace, gated as
  before. `test/unit/env-recovery.test.ts` guards the reconstruction; extras section T
  deletes the real file and boots again.
* A detected check must be able to fail *and* able to pass. `npm init` scaffolds
  `test: echo "Error: no test specified" && exit 1`, and moat offered it as the project's
  own check: `moat verify` printed FAIL as the project's verdict on work no test had
  looked at, and the agent's brief told it to run that command. An `echo` with nothing
  else is the same problem the other way round (it can only pass). `detectChecks` filters
  both (`isRealScript`); `test/unit/checks-detect.test.ts` and extras section W hold it
  there.
* The agent brief must describe the boot that was actually made, so every claim in it is
  rendered from `InstructionsInput`. Two inputs were declared and never read
  (`hasCredential`, the profile list): a boot against a local endpoint, with no credential
  injected, was told to guard a key it did not have, and every boot without `--profile db`
  was told PostgreSQL and Redis were installed and to start them. `db` is never
  auto-detected. Adding a claim to the brief means rendering it from an input and writing
  both branches; `test/unit/instructions.test.ts` fails if either paragraph goes
  unconditional again.
* The doctor's probe is part of the measurement, so it must model the box the agent gets
  and not a fuller one. `injectedVarNames` injected every credential name unconditionally,
  so a box booted with `--no-credential` (the "nothing stealable in the box" mode, SPEC
  §1.3) was reported as `credential visible to the agent` with `DEEPSEEK_API_KEY` and
  `MOAT_INJECTED_CREDENTIAL`, names that existed only inside the probe, and a custom
  endpoint was reported as having `DEEPSEEK_API_KEY`, which it never has. The list now
  comes from `doctorInjectedVarNames({ credential, native, credentialVars })`
  (`secrets/broker.ts`), and the wording helpers (`ownEnvNote`, `credentialExposureDetail`
  in `sandbox/isolation.ts`) only call the names that carry a credential "the credential".
  `credentialVars` is the third correction and the one Phase 1 needed: the only credential
  name the probe could model was `DEEPSEEK_API_KEY`, so a box configured against any other
  provider — which now exists — was reported as having that variable while the variable it
  really has went unlisted. It is derived in `cmd/main.ts` (`doctorCredentialVars`) from the
  same function the boot uses, so the probe and the box cannot drift.
  `test/unit/doctor-claims.test.ts` holds the first three;
  `test/unit/provider-security.test.ts` holds the provider half; extras section AH is the
  two-box end-to-end (keyless, plus a credentialed control).
* Copy-out scans for the credential it carries, and the value can only come from the host:
  the sandbox stores a fingerprint, never the key. `sync/leak-scan.ts` compares against
  `DEEPSEEK_API_KEY`/`MOAT_CREDENTIAL`/the credential store at fetch/apply time, so a key
  rotated between boot and fetch is invisible to it, a limit recorded in SPEC §4 and in
  the "Not verified" table; the scan says when it did not run at all (`noteScanSkipped`).
  The value must never reach argv: `git grep` gets it through a 0600 patterns file,
  because every process on the machine can read `ps`. It is a warning, not a gate, and
  `moat apply` still writes the file; extras section AB checks both halves.
* "What does the sandbox hold that the host cannot reach?" is a question about **every ref
  in the box**, not about HEAD. `countUnfetched` (`sync/copyout.ts`) used to resolve the
  sandbox HEAD only, so an agent that left a commit on `experiment` and switched back to
  the session branch looked like an empty box: the next `moat up` after the host project
  changed re-copied the project over it, and the branch, the commit and the file were
  gone, with a warning that said the sandbox "holds nothing that is not already on the
  host". The same undercount disabled the `--fresh` gate. It now takes every `refs/heads`
  and `refs/tags` tip, asks the host which it knows (`cat-file -e`), counts the known ones
  with `rev-list --count ... --not --all` on the host, and counts the unknown ones inside
  the box against the clone-time remotes *and* the host refs the box can see
  (`refs/moat/*`, the user's branches, tags); without that second set, a branch that was
  fetched and then advanced counts twice. When the host is not a repository at all, every
  commit the agent added counts. **HEAD counts too**, even detached: a commit on a
  detached HEAD is on no branch, and the drift re-copy destroyed exactly that commit while
  saying the sandbox held nothing, and `moat fetch` could not have collected it, so when
  HEAD is detached the warning names the way out
  (`moat exec -- git -C /work branch keep && moat fetch keep`). Two traps inside that: a
  count of `0` is a real answer, so never write `parseInt(x) || fallback` (it turns 0 into
  the fallback), and the warning must follow the *count*, not the decision.
  `test/unit/unfetched-count.test.ts` has the side-branch, multi-branch, tag and non-git
  cases; extras section AD is the two-boot proof, with a control that fetched work is
  still re-copied over.
* `moat restore` stages beside the rootfs and swaps with renames, so a bad snapshot cannot
  destroy the environment. Do not go back to deleting the live rootfs first: that is how
  an afternoon of installed packages and an agent's work disappears together.
* Snapshot names meet `path.join` only after `validateSnapshotName`. A raw argv join is
  how `../evil` writes outside `envs/<id>/snapshots`.
* The same rule covers every other argv that becomes a path or a number:
  `moat logs <name>` goes through `validateLogName` (`lib/paths.ts`), measured, without it
  `moat logs ../../../../../tmp/x` printed `/tmp/x.log`, a host file outside the
  environment; `--tail` through `positiveIntFlag` (a bad value used to mean "the whole
  file"); every up/run flag validated before provisioning (a typo used to survive the
  copy-in and surface as a boot failure); and `moat models <provider>` checked against the
  one provider instead of silently listing DeepSeek and exiting 0.
* Flags are validated **before provisioning**, because the ones validated at their use
  site fail after the copy-in and read as a boot failure: `--model ""` and `--base-url ""`
  used to boot a config with an empty model id or base URL and fail much later, and a bad
  `--log-level` silently became INFO. A flag whose value cannot work now fails in under a
  second, with the flag named.

**The agent-controlled rootfs**

* The rootfs is persistent and the agent is root inside it, so **it can replace any of its
  directories with a symlink to a host path**. The host process resolves that path on the
  next boot: measured, with the old code, the config write put an `AGENTS.md` of 3834
  bytes into a directory outside the rootfs, on *every* boot. Every host-side write into
  the rootfs goes through `lib/rootfs-fs.ts` (`writeRootfsFile`, `ensureRootfsDir`,
  `chmodRootfsDir`), which refuses symlinked or non-directory components, opens the temp
  file with `O_EXCL|O_NOFOLLOW`, verifies the file it actually opened via `/proc/self/fd`,
  and renames it into place. Do not `fs.writeFileSync(path.join(rootfs, ...))` directly.
  `test/unit/rootfs-write.test.ts` guards it.
* Reads of agent-controlled files go through `readRootfsFile`, same reason: a symlinked
  `boot.log` would otherwise print a host file to your terminal. Writes *outside* the
  rootfs (`runtime/boot-*.sh`, `logs/`) are not reachable by the agent and stay on plain
  `writeAtomic`.
* The boot log is opened **on the host** through the same guard and passed to the boot
  script as descriptor 3; the script dups it (`exec 1>&3 2>&3`) instead of redirecting to
  a path. A path resolve in the boot shell would follow a symlink planted in the
  agent-writable rootfs and point the host's write at a host directory.
  `test/unit/rootfs-write.test.ts` asserts the script contains the dup and never the path.
  The lines before the dup still go to `logs/sandbox.log` outside the box, the fallback
  when a boot dies before it gets that far.
* Text from the sandbox is untrusted **as terminal input**, not only as data. The answer,
  the reasoning, commit subjects, branch names, change paths, session titles and the boot
  log all come from inside the box, and a terminal acts on the escape sequences in them:
  OSC 0 retitles the window, OSC 52 writes the clipboard where the terminal allows it, CSI
  2J clears the screen, and a carriage return overwrites the row, enough to repaint the
  transcript the user is reading. Tool output was already stripped (`stripAnsi`); the
  model's own words and most of the sandbox metadata were not. Every such site now strips
  at the print boundary, and `stripAnsi` (`lib/terminal.ts`) removes every ESC byte, as a
  sequence *or* as a control character, so a sequence split across two writes cannot be
  reassembled on screen. Do not print a string that came out of the sandbox without it.
  `test/unit/terminal-text.test.ts` holds the stripper, and `test/e2e-codex.sh` section 10
  holds the end-to-end half on bytes: a scripted answer carrying OSC 0, OSC 52 and CSI 2J
  must leave zero ESC bytes in the captured output, with a control that the matcher does
  find an ESC byte when one is there.
* The project's own **check output** is the same untrusted text: `moat verify` streamed it
  to stderr chunk by chunk, and `moat take` and the session's `/verify` printed the last
  lines of a failure, none of them stripped. A failing test the agent wrote could retitle
  the window or clear the screen while the user read the output of the command they ran
  *instead of* trusting it (measured: four raw ESC bytes on the terminal from a `test`
  script). All three strip now (`stripAnsi(chunk)` for the stream, per line for the
  listings); per chunk is safe because `stripAnsi` removes every ESC byte. Extras section
  AI asserts on the bytes: zero ESC in the verify and take captures, marker text still
  present in both.
* Snapshot extraction needs no guard of its own, and that was measured rather than
  assumed: GNU tar refuses to write through a symlink its own archive created
  (`Cannot open: Not a directory`, target untouched), and `restoreEnv` treats a non-zero
  tar exit as a failed restore and rolls back.
* `apk` trusts its database over the filesystem. Deleting `/usr/sbin/nft` without touching
  apk's records leaves `apk add nftables` with nothing to do, so `ensurePackages` has a
  `resetFirst` mode (`apk del` the entry, then install) and `ensureFilterTool` uses it
  when the binary is still missing after a normal install. That is how the bug was found:
  the e2e check deletes the binary and the boot then failed with "this image has none".

**Downloads and caches**

* Every network artefact is checked against a digest pinned in `lib/pins.ts` (Alpine's
  release SHA-256, the Codex platform tarball's `sha256`) through `verifyFile` before
  anything unpacks it, and an already-cached file is re-checked. Do not add a download
  path that skips this.
* Temp files are named with `partPath()`: pid **and** a random suffix. A pid alone
  collided for two concurrent downloads in one process, and the loser's rename failed;
  write-then-rename is what makes the cache safe to share.
* The provisioned image cache carries a `.sha256` sidecar written when it was built; a
  mismatch rebuilds the image instead of unpacking it.

**Egress and the datapath**

* Always pass `--disable-host-loopback`. Without it slirp's 10.0.2.2 gateway forwards
  straight to the host's loopback: measured HTTP 200 for a host service from inside the
  "isolated" namespace. `moat doctor` probes **both** `127.0.0.1` and `10.0.2.2`, because
  testing only the namespace's own loopback passes while the hole is open.
* The predicate for "has its own namespace" lives in one place, `ownNetns()` in
  `lib/pins.ts`, because `filtered` was once spelled `opts.egress === "isolated"` at four
  call sites: the box then booted in the **host's** namespace and `nft -f` failed with
  `netlink: Error: cache initialization failed: Operation not permitted` (nft needs
  `CAP_NET_ADMIN` in the namespace's user namespace, and an unprivileged user has none in
  the host's). `bootIsolation()` now refuses to boot a ruleset outside the sandbox's own
  namespace, and `test/unit/egress.test.ts` fails if either predicate regresses.
* The in-box connectivity probes are wrapped in `timeout`: a default-deny policy **drops**
  packets, and an unbounded `/dev/tcp` connect sits in the kernel's SYN retries for about
  two minutes before reporting the failure it already knows about. `moat doctor` in
  filtered mode is the case that hits it.
* **The filter is not a jail.** The sandbox owns its netns, so uid 0 inside holds
  `CAP_NET_ADMIN` there. Measured: `nft flush ruleset` inside a filtered box exits 0 and
  `curl https://1.1.1.1/` then answers 301, where it had timed out before. Every boot
  re-applies the ruleset and `moat doctor` re-measures it, so this is detected on the next
  run, never prevented. Do not describe the policy as containment; SPEC §7.3 says what it
  buys.
* An allowlist host that does not resolve is dropped from the ruleset. Fine for an extra
  registry, fatal for the provider: a filtered box with no provider address boots happily
  and fails only when the agent calls the model. `moat up` fails with "could not resolve
  <host>" and names the way out; other unresolved hosts are a warning, and ephemeral boots
  warn rather than fail (`moat exec` may be the diagnosis). `resolveAllowlistDetailed`
  reports the failures; `resolveAllowlist` is the addresses-only wrapper.
* A provider URL has to be **usable**, not merely parseable. `new URL()` accepts
  `localhost:11434/v1`, the scheme-less form of the endpoint moat's own error text
  suggests, as protocol `localhost:` with an empty hostname, and everything downstream
  reads `.hostname`: `providerHost()` puts no provider in the filtered allowlist,
  `providerProbe()` hands the doctor no endpoint, and
  `reportUnresolved(..., undefined, true)` has nothing to fail on. Measured: `moat up`
  booted filtered with no provider address (exit 0, ready in 13s) and `moat doctor`
  printed "the provider is reachable" for a probe it never ran. `checkBaseUrl`
  (`lib/provider.ts`) runs before provisioning for both `--base-url` and `--upstream`;
  `filteredEgressCheck` (`sandbox/isolation.ts`) says the check is one-sided rather than
  claiming a probe that did not happen. Extras section AC is the refusal plus the control;
  `test/unit/base-url.test.ts` and `test/unit/doctor-egress.test.ts` hold both halves.
* The provider **configuration** and the credential are separate things, and the box needs
  the first without the second. `MOAT_PROVIDER_BASE_URL`/`MOAT_MODEL_ID`/`MOAT_MODEL` were
  set only inside `toSandboxEnv(minted)`, so `moat up --no-credential` (a documented mode,
  SPEC §1.3) left the custom-endpoint provider block with an empty base URL: the runtime
  resolved the base URL to `""` and every call died *inside the box*, while the host
  printed nothing but "0 tool calls". `sandboxProviderEnv()` (`secrets/broker.ts`) is now
  injected unconditionally into `managedEnv`, and the task guard refuses a task without a
  credential only for the *native* provider, where the key is the model. A custom endpoint
  can run with no credential at all, and the rendered config then carries **no `env_key`**
  rather than pointing at a name nothing sets (measured: the stub records
  `authorization: null`). Extras section AF is that run plus the native control;
  `test/unit/provider-env.test.ts` pins the split.
* A project file name that is not valid UTF-8 is refused by `assertAddressableNames`
  (`lib/fs-names.ts`) at the start of `copyIn` and `hashTree`, naming the bytes. Node
  decodes such a name to U+FFFD, which is not the name on disk, so the next `lstat`
  reports ENOENT for a file that is right there (measured: `hashTree` on `bad\xffname`).
  Supporting them means Buffer paths through every host-side walk (hashing, the
  untracked-file pass, apply's tree reads); that does not exist yet, and pretending
  otherwise would drop files silently.
* A filtered boot needs `nft` inside the image, and *every* path that boots one has to
  ensure it (`ensureFilterTool` in `cmd/main.ts`), not just `moat up`. An environment
  restored from a snapshot taken before nftables was baked in used to fail `doctor` and
  `exec` with "[moat] failed to apply the egress policy", which reads like a moat bug
  rather than a missing package.
* The long-running box records its slirp pid in `state.json` and `moat down` stops it
  after the box (its start time is checked, like the sandbox pid). Ephemeral boots
  (doctor, exec, checks, shell) start their own slirp, so they run in the same kind of
  network as the box rather than quietly measuring a different one. **A box that dies out
  of band leaves that datapath running**, and it is a *separate* process: only a command
  holding its pid on record can reap it, and every command that ends a box reaps before it
  lets go of that record. `forgetBox` (`cmd/main.ts`) is the single place the CLI clears
  it (four endings inside `up`, three branches in `down`, two in `restore`), and it reaps
  first. `destroy` reaps the same way without writing a state (the `--all` path through
  `stopSandbox`, the single-environment path through the helper when the box is gone). Do
  not write `slirpPid: null` anywhere else: clearing the record without reaping is the
  bug, and it was live in three commands at once after `up` was fixed (`moat down` printed
  the stale-identity warning, nulled `slirpPid`, and left the process running with nothing
  on disk naming it; `moat destroy --yes` deleted `state.json` and the environment with
  the process still up; measured: one `kill -9` of the box, then `moat up` gave two
  slirp4netns processes and destroy took only the new one; extras section AG has the
  capture for all four commands). `stopSlirp` signals a pid only while its start time
  matches, so a reused pid is left alone. `test/unit/stop-slirp.test.ts` covers that
  guard, `test/unit/datapath-reap.test.ts` fails on a direct `slirpPid: null` write
  outside `forgetBox`, and extras section AG is the end-to-end reap.

* **One runtime, and it is a CLI.** Codex is driven two ways (`codex exec --json` for a
  task and its own TUI for a session), and neither is a server, so the long-running box is
  a keepalive (`codexEntryScript`) and every task, TUI session and check runs in its own
  ephemeral boot of the same rootfs. The config moat renders (`bundle/codex.ts`, written
  through the rootfs guard on every boot) is what keeps Codex from asking for approvals or
  adding its own sandbox: **never let the agent own that file.** The runtime is *pinned
  and digested* in `lib/pins.ts` like slirp4netns, because it becomes the code the agent
  runs; the npm platform tarball ships a **musl** build, so it runs on the Alpine image
  with no gcompat and no Node. Adding a binary to the image means adding it to
  `imageCachePath`'s key or a cached image will silently lack it. `bundle/codex.ts` also
  parses `codex exec --json`; `test/unit/codex-runtime.test.ts` pins the parser against a
  real captured stream and the rendered config against the load-bearing lines.
  `docs/HISTORY.md` holds the runtime history and the measurements behind it.
* **The model catalog is policy too, and its `base_instructions` is a prompt
  pin.** `installCodexFiles` writes `models.json` to `/root/.codex/models.json` on every
  boot, and the rendered config points `model_catalog_json` at it. It used to be
  `bundle/deepseek-models.json`, 38KB of one vendor's metadata installed byte-for-byte;
  it is now rendered per boot from the model that boot configured
  (`bundle/model-catalog.ts`), so the metadata always describes the model in use and a
  boot against any provider gets that provider's model described rather than DeepSeek's.
  The field set is measured, not guessed: the pinned binary names each field it needs and
  refuses the file without it, and ten are required (`slug`, `display_name`,
  `supported_reasoning_levels`, `shell_type`, `visibility`, `supported_in_api`, `priority`,
  `support_verbosity`, `truncation_policy`, `experimental_supported_tools`).
  `shell_type` and `apply_patch_tool_type` are behavioural — they choose the tool surface —
  so a provider override changes what the agent can do rather than how it is labelled.
  `base_instructions` **or** `model_messages.instructions_template` is required on top of
  those: measured, the binary exits 1 with neither. So the field stays and carries the
  *pinned binary's own* built-in prompt, sha256 `3b08633f...`, kept as a source constant in
  `bundle/codex-prompt.ts`; with the catalog installed Codex sends exactly that text as the
  request's `instructions`, so the catalog changes metadata and never the prompt.
  **A Codex version bump can move that built-in prompt, and can add required fields;
  refresh the pin in the same commit**, or the agent keeps running a stale prompt while the
  binary moves. The refresh recipe is in the `bundle/model-catalog.ts` comment, and
  `codex debug models` is the useful half: it prints the binary's own fully-resolved
  catalog entry as JSON, which is where the field values and the required set come from.
  `--effort` is a separate seam and **does not need the catalog at all** — measured with no
  `model_catalog_json`, `model_reasoning_effort = "high"` still reaches the wire; what the
  catalog buys is the absence of the "Model metadata for `X` not found" advisory and the
  declared limits. `test/unit/model-catalog.test.ts` pins the prompt digest and the
  required fields, `test/unit/codex-runtime.test.ts` pins the config lines; extras section
  AK asserts the metadata notice's absence, the level on the wire, and no `web_search` from
  the stub's record, and `test/e2e-provider.sh` asserts the same for a non-DeepSeek
  provider.
* **One model, described once.** The model a boot is configured to use is resolved into a single
  `ModelFacts` record (`lib/model-facts.ts`), and every consumer reads that record: the rendered
  TOML, the catalog Codex parses, `--effort` validation, the boot log and the task report. It
  used to be described twice by two modules that disagreed — models.dev knew the default model's
  name (`DeepSeek V4.1 Flash`) while the catalog handed to Codex carried the raw id
  (`deepseek-flash`), so one boot used two names for one model. **Do not build a catalog entry or
  read a context window from anywhere but the facts record**: a second path is a second
  description, and `test/unit/model-facts.test.ts` covers the three branches a model arrives
  through (described by models.dev, named by a provider but not described, a `--base-url` model
  nobody has published) plus the case where the catalog could not be fetched at all. The
  division of labour is the thing to keep: **models.dev** is the host's broad picture (which
  providers exist, which ids they define, context/output/name/capabilities) and is fetched and
  optional; **moat's own ladder** is the one fact neither catalog can supply (models.dev says
  whether a model reasons and nothing finer), per provider when the provider declares one; and
  **the model id** is always a fact. An unknown model is not an error — that is the `--base-url`
  case the whole suite runs on — so it boots with the id as its label and no declared limits, and
  says so.
* **The baseline is the commit, not the working tree with your uncommitted work in it.**
  `recordBaseline` (`sync/copyin.ts`) records **HEAD**. It used to `git add -A` and commit the
  result, which reads like "exactly what was copied" and silently disabled the product's central
  claim on the most common state a repository is in: `planApply` decides whether a file is yours
  by comparing the host against the baseline, so a file you had *already* edited compared equal to
  a dirty baseline and the agent's version went over your work as a plain "update", with no
  conflict and nothing said — contradicting SPEC §2.2. Measured before the fix: your edit gone,
  `applied 2 change(s); skipped 0`. The working tree still travels with the copy-in unchanged, so
  the agent sees your work; only what counts as "before" changed. With no HEAD (a repository
  nobody has committed to) the baseline is the empty tree, and `test/unit/baseline-content.test.ts`
  holds all of it. Related trap, same file: **`copy-in` of a repository with no commits yet copies
  no working tree at all** — `git clone` of an unborn HEAD brings the repository and none of the
  files — so such a project arrives in the sandbox empty and nothing says so. That one is
  documented by a test rather than fixed.
* **A missing runtime binary is repaired, never re-provisioned.** The agent is root in its
  own rootfs, so it can `rm /usr/local/bin/codex`, and an environment made by an older
  moat never had it. The next boot copies it into the live rootfs through
  `installRuntimeBinary` **instead of** provisioning: `provisionEnv` starts with
  `fs.rmSync(rootfs)` and takes `/work` with it, measured, and an untracked file was lost
  that way. `test/unit/runtime-install.test.ts` holds the symlink guard and extras section
  AJ holds the /work half end to end. The image cache key names the binary and its pinned
  version (`imageCachePath`), so a cached image cannot silently lack one.

* **An interactive boot forwards TERM; nothing else does.** `sandboxEnv` fixes `TERM=dumb`,
  right for a boot nobody is watching and wrong for one attached to a terminal: the first
  time `moat` was run under the default runtime, Codex's TUI opened with
  `WARNING: TERM is set to "dumb". Codex's interactive TUI may not work in this terminal. Continue anyway? [y/N]`
  and waited for an answer, and bash loses its line editing the same way. `runInteractive`
  advertises the host's terminal type through `interactiveTerm`, sanitised: it is a
  capability name from the host environment, not host data, and no whitespace or
  punctuation reaches the box. `test/unit/interactive-term.test.ts` holds both halves,
  including that a check or a batch boot still gets `dumb`, so the environment the other
  suites measure is unchanged; `test/codex-tui.py` (extras section AL) is the pty proof
  that `moat` reaches a live TUI and that leaving it leaves the box running.

* **`test/e2e-codex.sh` is the acceptance suite.** It drives `moat run` through
  `stub/mock-responses.mjs`, the Responses wire API, whose event shapes were captured from
  a real DeepSeek stream, and asserts the whole list with no key: cold start, the doctor's
  isolation checks, a mocked turn that fixes the fixture and whose `moat verify` passes,
  host paths and the canary unreachable, one ref from `moat fetch` with the host tree
  byte-identical, the credential absent from the rootfs, persistence across `moat down` +
  `moat up`, and (section 10) that an escape sequence in the model's answer never reaches
  the terminal. The one criterion it names as deliberately absent is the opencode plugin's
  in-box permission guard; under Codex the same guarantee is the rendered config, which
  section 4 and extras section AJ assert instead.

**Pipes and encodings**

* `run()` in `lib/shell.ts` captures a child's stdout as a UTF-8 **string**, which is
  wrong for anything binary. Piping a tar archive through it corrupted the archive: a byte
  that is not valid UTF-8 becomes U+FFFD and re-encodes to three bytes, so the stream
  grows, every later header is read from the wrong offset, and tar stops partway. This
  silently broke `moat apply` on any project containing a binary file. Binary data goes
  through a **file**, not through this process.
* A child that exits before its input is fully written closes the pipe, and Node raises
  EPIPE on the stdin socket; with no `error` listener that is an unhandled event and it
  kills the process. `run()` swallows EPIPE deliberately: the child's exit code is the
  thing worth reporting.

**DeepSeek**

* models.dev prices are wrong for `deepseek-v4-pro`, and it has no notion of peak hours,
  which double every rate. `lib/pricing.ts` holds the published table.
* The Responses `input_tokens` field **includes** the cached tokens, so moat subtracts
  `cached_input_tokens` before pricing the miss rate. Charging the raw field
  double-counted a mostly-cached turn by about ten times; `parseCodexEvents` normalises it
  and `test/unit/codex-runtime.test.ts` pins the arithmetic. `reasoning_output_tokens` is
  billed at the output rate as a field separate from `output_tokens`.
* `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are retired names served by the
  current Flash model. `deepseek-flash` is the current name.

**This codebase**

* SPEC is the contract, so it must not carry a count the tool prints. The `moat doctor`
  row promised "15 isolation assertions" while the three egress modes print 14 (`open`),
  16 (`isolated`) and 17 (`filtered`), and the command prints the count itself, so nothing
  kept the number honest. Counts belong in the capture (`docs/VERIFICATION.md` §4b) and in
  the tool's own output, not in a hand-maintained table; `test/unit/docs-claims.test.ts`
  fails if that row states a count again.
* Node's type stripping cannot desugar TypeScript parameter properties
  (`constructor(private readonly x: T)`). Use plain fields. `tsconfig` sets
  `erasableSyntaxOnly`, so this fails at typecheck.

## What is verified, and what is not

`docs/VERIFICATION.md` is the authority, and it is deliberately organised so that absence
is not mistaken for success. Read its closing table before claiming anything works.

Two rules the suite follows, worth preserving:

* **Assert on the thing, not on moat's account of the thing.** `stub/mock-responses.mjs`
  records the request it received, including whether an `Authorization` header was sent,
  so a test reads what the provider would have seen rather than what moat says it sent.
* **A check that cannot fail is not a check.** When adding a regression guard, reintroduce
  the bug and watch it fail before trusting it.

## Where this is going

Not built, in rough order of how much they matter:

* **Egress policy, second half.** Done: a new environment gets its own network namespace,
  the pinned slirp4netns datapath, a closed host loopback on both routes, and an nftables
  default-deny allowlist resolved at boot, with `bash test/e2e-egress.sh` proving the
  allowed and the blocked path without a key and `moat doctor` failing the run when either
  is wrong. What is left is the allowlist's shape: it is an IP snapshot taken at boot (a
  rotating CDN address falls out until the next `moat up`), it cannot express per-host
  ports, and DNS to slirp's resolver remains an outbound channel. Closing those means a
  resolving proxy moat owns, not a bigger ruleset.
* **Provider-side credential scoping**: short-lived, spend-capped tokens minted per boot,
  instead of borrowing a long-lived key.
* **Cost ceilings.** The turn footer reports what a turn cost; nothing stops it.
* **v1: a microVM.** The current isolation is namespaces, which is v0. `/dev/kvm` exists
  on this host but is not accessible to the user.
* **Byte paths for file names that are not valid UTF-8.** `assertAddressableNames` refuses
  them today with a clear message instead of an ENOENT for a file that exists; supporting
  them means Buffer paths through hashing, the untracked-file pass and apply's tree reads,
  plus a digest encoding that keeps today's hashes for UTF-8 names.
* **Tool-set curation.** Under Codex moat does not choose the tool list: the CLI ships its
  own (`exec_command`, `write_stdin`, `view_image`, `multi_agent`, the goal tools) and
  moat's box, not a tool filter, is what bounds them. `web_search` is the one entry the
  config can turn off, and it is off (`web_search = "disabled"`): DeepSeek's API accepts
  the tool and ignores it (measured live: HTTP 200, no `web_search_call`, the model
  answering that it cannot search), so advertising it only invites calls that cannot work.
  The opencode-era plugin had a guard that refused tools outside a curated set; there is
  no equivalent here, and the docs say so instead of implying one.

If you are picking this up: the sandbox, the copy-in/copy-out and the credential broker
are the parts that matter and they are done. The agent runtime is Codex's CLI, reached
through one pinned binary: `moat` renders its config, hands it a pty or reads its JSONL
stream, and owns nothing else about it. Treat that boundary as the seam to change things
at.
