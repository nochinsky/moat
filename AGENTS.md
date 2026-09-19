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
  `objects/info/alternates`, and restores the agent's config afterwards. Do not
  add a raw `run("git", ["-C", paths.work, ...])` call; it will typecheck and
  quietly reintroduce the bug. `test/unit/git-hardening.test.ts` guards it.
* The sanitized config drops `user.*` like everything else. Any host-side commit
  must pass `GIT_AUTHOR_*`/`GIT_COMMITTER_*` explicitly, as the three commit
  paths in `sync/` already do.
* `moat apply` parses git output with `-z` and merges into one temp file per
  path. Without `-z`, `a  b` parses as `a b` and moat touches the wrong file;
  with one shared temp file, every merge after the first gets the last file's
  content. Both are covered by `test/unit/apply.test.ts`.

**Processes, scripts and logs**

* A pid is not an identity. `state.json` records `pidStart` from
  `/proc/<pid>/stat` when the box is spawned, and `sandboxPidStatus` is the only
  thing that decides whether a recorded pid is safe to signal. Do not call
  `isRunning` on a stored pid; a reused pid would send SIGTERM and SIGKILL to a
  bystander's process group.
* Boot scripts are unique per invocation (`boot-<pid>-<rand>.sh`,
  `entry-<pid>-<rand>.sh`) and written with write-then-rename, because two host
  processes can boot one environment at once (`moat doctor` while `moat up`, or
  `moat exec` during a restart). `boot.sh` and `entry.sh` are audit copies of
  the most recent boot, not the files that run.
* The long-running box redirects its output to `<rootfs>/var/log/moat/boot.log`,
  inside its own rootfs. It must not hold an append fd on a host file outside the
  box, which is what the old `stdio: [fd, fd]` gave it. `moat logs sandbox` and
  the boot-failure tail read the rootfs file; `logs/sandbox.log` only holds the
  lines before the redirect.
* `moat up --fresh` deletes `/work`. It refuses while a sandbox is live and
  refuses without `--yes` when the box holds unfetched commits or uncommitted
  files.
* `moat restore` stages beside the rootfs and swaps with renames, so a bad
  snapshot cannot destroy the environment. Do not go back to deleting the live
  rootfs first: that is how an afternoon of installed packages and an agent's
  work disappears together.
* Snapshot names meet `path.join` only after `validateSnapshotName`. A raw argv
  join is how `../evil` writes outside `envs/<id>/snapshots`.

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
* **Exact tool advertisement**, which needs an upstream change (see
  `docs/UPSTREAM-CANDIDATES.md`).

If you are picking this up: the sandbox, the copy-in/copy-out and the credential
broker are the parts that matter and they are done. The agent runtime is
opencode's, reached through thirteen HTTP calls. Treat that boundary as the seam
to change things at.
