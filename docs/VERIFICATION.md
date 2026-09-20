# Verification

The acceptance criteria, each with the command that produced it and its real
output. Nothing here is paraphrased: the blocks are copied from `test/evidence/`,
which the suites write.

A note on paths: the captured output was produced on the author's machine, and
`/home/<user>` was rewritten to `/home/user` before publication. Nothing else in
any command or its output was altered.

```
bash test/e2e-codex.sh    # the acceptance list, keyless        -> test/evidence/codex-summary.txt
bash test/e2e-extras.sh   # the state and process traps         -> test/evidence/extras.txt
bash test/e2e-egress.sh   # netns, slirp datapath, allowlist    -> test/evidence/egress.txt
DEEPSEEK_API_KEY=... bash test/e2e-live.sh   # a real model, a real task
```

**Environment under test**

```
host
  platform   linux x64 wsl2 userns=yes kvm=no
  unshare    /usr/bin/unshare
  chroot     /usr/bin/chroot
  user ns    available
  pid ns     available
  /dev/kvm   absent (v1 microVM path unavailable here)
  note       no usable /dev/kvm (present but not accessible to uid 1000 (mode 660, gid 991)):
             v1 microVM unavailable here; the v0 container path is the supported mode
  note       mknod denied in userns (kernel policy): /dev nodes are bind-mounted from
             the host's device nodes (rw: a device is an interface, not a file). No host *data* is mounted.
```

`kvm=no` means `v1` is untestable on this machine, which is why it is out of
scope here. WSL2 is supported via the container path only.

**On the model.** The acceptance criteria below were produced with a deterministic
local model stub, because this host had no provider credentials at the time:

```
$ env | grep -iE 'api_key|token|anthropic|openai|deepseek|gemini'
(no output)
```

So the suites drive a deterministic local OpenAI-compatible stub
(`test/mock-responses.mjs`, speaking the Responses wire API) that sits exactly where
a real endpoint sits. Everything inside the sandbox is real: the pinned Codex CLI
and its own tool loop, `exec_command` (which runs a shell inside the box), its
file-editing tools, and `git`. What the stub does not test is model quality. A real
DeepSeek session was subsequently run against the same build, see "A real model,
doing a real task" below, so the stub is no longer the only evidence.

---

## Exposures, read this before the criteria below

The criteria that follow show a box that protects your host. They do not show a
box that protects your **project** or your **credential**, and it would be
dishonest to let a page of green `pass` marks imply otherwise. `moat doctor`
therefore prints these on every run, in a separate section, sourced from
measurements taken inside a real boot. The transcript below is from a box whose
network policy is `open`; in the default `filtered` mode the middle two lines are
not exposures at all but `check`s that must pass (`pass egress filtered`, `pass
host loopback reachable`, see §L).

```
$ moat doctor

exposures, measured, and NOT fixed in v0. Read these before trusting the box.
  expose  credential visible to the agent
          MOAT_CREDENTIAL_EXPIRES_AT, MOAT_CREDENTIAL_TTL_SECONDS, MOAT_CREDENTIAL_FINGERPRINT,
          MOAT_INJECTED_CREDENTIAL are in the environment tool execution inherits: the box's
          process environment, readable via /proc/<pid>/environ. That is how the agent calls the
          model, so the mitigation is a provider-scoped, spend-capped token rather than hiding
          the value.
  expose  host loopback reachable
          the sandbox connected to a service the host opened on 127.0.0.1:35967. Every service
          you run locally (databases, dev servers, notebooks) is reachable by the agent.
  expose  egress unrestricted
          the sandbox reached 1.1.1.1:443. It shares the host's network namespace (egress mode
          "open"), so the agent can install dependencies AND exfiltrate anything it can read,
          including the project and the injected credential. A new environment defaults to
          "filtered".
$ moat up --json --model mock-model --base-url http://127.0.0.1:5599/v1 \
        --credential-env MOAT_MOCK_CREDENTIAL
```

The committed capture is `test/evidence/codex-up.txt`. The fields that matter:

* **cloned in**: `copyIn.transport: "git"`, with the dirty working tree carried across
  (`dirty: true`, one modified tracked file and one untracked file in the fixture), and a
  digest moat recomputes on the host before and after (§4a).
* **provider**: a custom OpenAI-compatible endpoint on the host's loopback, which is also
  why egress chose `open`, the documented exception in §7.3 of `docs/SPEC.md`.
* **the runtime is ready**: `readyCheck: "the codex runtime has no server to wait for"`.
  There is no port and no `url` in the output, because there is no server; the same suite's
  `codex-status.json` carries `"runtime": "codex"` and nothing to connect to.
* **the config moat rendered** is read back with `moat exec -- cat /root/.codex/config.toml`:
  `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`, and the provider block
  with `wire_api = "responses"` and `env_key = "MOAT_INJECTED_CREDENTIAL"`.

---

## Criterion 2: the interactive surface is Codex's own TUI

There is no client of moat's and no protocol between moat and the agent: `moat`, at a
terminal, hands the sandbox the terminal it inherited and execs Codex's TUI. That it is
reached, that it draws a screen, and that leaving it leaves the box running is proven
through a real pty by `test/codex-tui.py` (extras section AL, `test/evidence/codex-tui.txt`):

```
pass  the TUI was reached, not the help text
pass  it drew a screen and kept running
pass  Ctrl-C left the sandbox running
codex tui: the default runtime opens a live TUI
```

The check is keyless: a dummy credential is set so Codex has its variable, and nothing is
ever sent to a provider. What the TUI draws beyond that is the CLI's own program, and is in
the "Not verified" table.

---

## Criterion 3: the agent completes a task requiring shell + file edits with zero permission prompts

```
$ moat run "Create and edit a note file in the project, then commit it. Report what you did."
```

The host reads the CLI's JSONL stream and prints one row per item. Measured against the stub
(`test/evidence/codex-mock-run.txt`):

```
  ✓ /bin/sh -lc "cd /work && sed -i 's/a - b/a + b/' src/sum.js && npm test …"
Fixed src/sum.js so the test passes, and committed it.
  17280 tokens  1 tool
```

**Zero permission prompts** is a property of the rendered config rather than a counter:
`approval_policy = "never"` means no tool call can raise one, and there is no hook to fire.
What the acceptance suite asserts instead is the config itself (the two lines in Criterion 1)
and that a real turn ran to completion and committed its work.

The tools a turn is offered are recorded on the provider side by the stub, not declared by
moat (`test/evidence/codex-summary.txt`):

```
tools advertised to the model: ['create_goal', 'exec_command', 'get_goal', 'multi_agent_v1',
                                'request_user_input', 'update_goal', 'view_image',
                                'write_stdin']
```

That list is the CLI's, not moat's, and moat does not filter it; what bounds those tools is
the box. `web_search` is absent because the rendered config disables it, and that is the one
entry the config can turn off. See §6.1 of `docs/SPEC.md`.

---

## Criterion 4: proof the host is untouched

### 4a. The project tree is byte-identical before and after

The digest covers every path, mode bit, symlink target and file's content, and is
taken before anything runs and again after the full agent session *and* the
`moat fetch`:

```
$ node lib/hash.ts compare …
{
  "before": {
    "digest": "c73dfe12c6e22b9fd80294de7eea6122c85a25769a490fc97f4d28530d855158",
    "files": 3,
    "bytes": 126
  },
  "after": {
    "digest": "c73dfe12c6e22b9fd80294de7eea6122c85a25769a490fc97f4d28530d855158",
    "files": 3,
    "bytes": 126
  },
  "identical": true
}
```

The agent wrote `agent-output.txt`, edited it, committed it, and read the project.
The host's tree digest did not move.

### 4b. The mount table inside the sandbox, in full

```
  pass  host project not reachable     /home/user/moat-demo/project is absent inside the sandbox
  pass  host home not reachable        /home/user is absent inside the sandbox
  pass  host canary unreadable         /home/user/.moat/canary (mode 600, exists only on the host) is unreadable
  pass  no host ssh directory          host /home/user/.ssh absent; sandbox /root/.ssh absent
  pass  no host env forwarded          no variable from the host environment reached the sandbox; present: DEEPSEEK_API_KEY, HOME,
  pass  no host data mounts            13 mounts; none reference a host filesystem path
  pass  sandbox pid 1                  pid 1 is "sh", 4 visible processes
  pass  own mount namespace            sandbox mnt:[4026532312] vs host mnt:[4026532219]
  pass  own pid namespace              sandbox pid:[4026532315] vs host pid:[4026532221]
  pass  own user namespace             sandbox user:[4026532311] vs host user:[4026531837]
  pass  own uts namespace              sandbox uts:[4026532313] vs host uts:[4026532220]
  pass  own ipc namespace              sandbox ipc:[4026532314] vs host ipc:[4026532208]
  pass  uid mapping                    uid_map "0 1000 1", uid 0 inside is the calling user outside
  pass  device nodes are the only host mounts 6/6 device node bind(s), rw like every rootless runtime: /dev/full, /dev/null,
  pass  device nodes are real devices   all six device nodes are character devices inside the box
  note  network namespace shared       sandbox and host share net:[4026531833]. The agent has the host's network position.
```

That is the complete table: all 13 entries, not a filtered view. Reading it
against the criterion:

* **no host bind-mount of host data.** No entry references `/home`, `/mnt`,
  `/media`, `/usr/lib/wsl` or `/init`. The project is not mounted; it was copied.
* **the only host-originated mounts are six device nodes** (`/dev/null` and
  friends), bound read-write. This is the one place the criterion cannot be met
  literally: `mknod` is refused inside an unprivileged user namespace (`EPERM`,
  verified by `moat doctor`), so these cannot be created from nothing. They carry
  no host data, and remounting them read-only makes `> /dev/null` fail, which is
  why the mount flags in the table above say `rw`. `docs/SPEC.md` §7.2 states
  this in full.
* **each of those binds is verified, not assumed.** The boot binds a device,
  checks `[ -c ... ]` on the result and refuses otherwise (the failure mode is a
  regular file at `/dev/null`, which accepts writes and reports success), and
  `moat doctor` re-measures it as the row above. The control for that row is in
  `test/e2e-codex.sh` §3: the same `-c` test, run in a live box over
  `/dev/null` and `/etc/hosts`, reports the regular file, so the passing row is
  a measurement that can fail. `test/unit/rootfs-write.test.ts` holds the boot
  script's refusals and `test/unit/doctor-mounts.test.ts` holds the mount
  analysis; both were watched failing against the previous revision.
* **`/` is `ext4 /dev/sdd`**: the sandbox root is a directory on the host disk,
  which is how it persists between sessions. It is the sandbox's own rootfs, not
  a view of the host's `/`. Confirmed by the next check: neither `/home/user` nor
  the project path exists inside it.

The check count is the **mode's**, not a constant: this capture is `open` and printed
14 checks (plus 4 exposures and 1 note). `isolated` prints 16
(`test/evidence/doctor.txt`) and `filtered` 17 (`test/evidence/doctor-filtered.txt`);
the extra checks are the network namespace, the host loopback as a check rather than a
documented exposure, and the two-sided egress check. `docs/SPEC.md` §2.4 deliberately
carries no number (it said "15 isolation assertions" for a while and nothing kept it
honest), and `test/unit/docs-claims.test.ts` fails if a count comes back.

### 4c. The sandbox is not just chrooted: every namespace differs from the host

```
  pass  own mount namespace   sandbox mnt:[4026532229]  vs host mnt:[4026532219]
  pass  own pid namespace     sandbox pid:[4026532232]  vs host pid:[4026532221]
  pass  own user namespace    sandbox user:[4026532234] vs host user:[4026531837]
  pass  own uts namespace     sandbox uts:[4026532230]  vs host uts:[4026532220]
  pass  own ipc namespace     sandbox ipc:[4026532231]  vs host ipc:[4026532208]
```

---

## Criterion 5: `moat fetch` delivers the agent's branch; `git log` on the host shows only what the user chose to fetch

```
$ moat fetch
→ copy-out: git fetch /home/user/.moat/envs/18620c2c4f34/rootfs/work +refs/heads/main:refs/moat/main
✓ fetched main -> refs/moat/main (3dd04fb81d33)
  2 commit(s) reachable, HEAD 0b97af8ec4d6 -> 0b97af8ec4d6
    3dd04fb81d33  agent: add agent-output.txt from inside the sandbox
    0b97af8ec4d6  initial demo project

  the host working tree was recomputed and is byte-identical
  inspect with:  git log refs/moat/main
  apply with:    moat apply main  (or --checkout)
```

Exactly one refspec crossed the boundary. `git log` on the host, for that ref:

```
$ git log --oneline --decorate refs/moat/main
3dd04fb agent: add agent-output.txt from inside the sandbox
0b97af8 (HEAD -> main) initial demo project
```

The host's own state did not move. `HEAD` is the same before and after, the
working tree is unchanged, and only the user's pre-existing edits are present:

```
host HEAD before fetch: 0b97af8ec4d6460038e833e6633fb00ca1d80168
host working tree after fetch (must be unchanged):
 M README.md
?? notes.txt
host HEAD after fetch: 0b97af8ec4d6460038e833e6633fb00ca1d80168
```

`--json` reports the same thing in machine-readable form, including
`"worktreeUntouched": true` and identical tree digests either side of the fetch:

```json
{
  "fetched": [{
    "branch": "main", "hostRef": "refs/moat/main",
    "sha": "3dd04fb81d33ff0ce0b26ad0a5d3dbdb02d7f41d",
    "commits": 2,
    "headBefore": "0b97af8ec4d6460038e833e6633fb00ca1d80168",
    "headAfter":  "0b97af8ec4d6460038e833e6633fb00ca1d80168",
    "worktreeUntouched": true,
    "commitsFetched": [
      { "sha": "3dd04fb81d33ff0ce0b26ad0a5d3dbdb02d7f41d", "subject": "agent: add agent-output.txt from inside the sandbox" },
      { "sha": "0b97af8ec4d6460038e833e6633fb00ca1d80168", "subject": "initial demo project" }
    ]
  }],
  "worktreeUntouched": true,
  "projectDigestBefore": "c73dfe12c6e22b9fd80294de7eea6122c85a25769a490fc97f4d28530d855158",
  "projectDigestAfter": "c73dfe12c6e22b9fd80294de7eea6122c85a25769a490fc97f4d28530d855158"
}
```

Precise scope of the "untouched" claim: `git fetch` necessarily writes objects
and one ref into the host repository's `.git`. What is verified is that the
working tree, `HEAD`, the index and every tracked file are unchanged. That is why
the digest above is taken over the working tree, and why `moat apply` exists as a
separate, explicitly-requested step.

---

### Uncommitted sandbox work is not collected, and now says so

`git fetch` reads a branch ref. Uncommitted work is in no ref, so it cannot be
collected by any fetch. An earlier version of the sandbox instructions told the
agent the opposite ("may still be picked up from the working tree"), which was
simply false, and there was no warning when it happened. Verified after the fix,
with two dirty files in the sandbox:

```
$ moat fetch
! the sandbox has 2 uncommitted change(s); `git fetch` reads a branch ref and cannot see them.
    M README.md
    ?? uncommitted-note.txt

  to collect them:  moat fetch --commit-worktree   (commits them in the sandbox, then fetches)
  or ask the agent to commit inside the box
```

The explicit form commits them in the box, then fetches, so the work lands:

```
$ moat fetch --commit-worktree
! committed 2 uncommitted file(s) from the sandbox as 039673d775f1 before fetching,
  because you passed --commit-worktree
✓ fetched moat-session-… -> refs/moat/moat-session-… (039673d775f1)
    039673d775f1  moat: uncommitted sandbox work, committed at fetch time

$ git show refs/moat/moat-session-2026-09-18-18-11:uncommitted-note.txt
work the agent never committed

$ git status --porcelain          # host working tree, unchanged
 M README.md
?? notes.txt
```

Nothing commits to a sandbox branch unless the user asks for it. The same
distinction protects the automatic re-copy when the host project changes: if the
sandbox holds work the host cannot reach, moat warns instead of overwriting it.

```
$ moat up                                  # host edited, sandbox has uncommitted work
! the host project has changed since it was copied in, but the sandbox holds 1 uncommitted
  file(s) that the host does not have. The agent will work on the OLD copy. Run `moat fetch`
  (add --commit-worktree to include uncommitted work) to keep it, or `moat up --sync` to
  discard it and re-copy.
```

```
$ moat exec -- cat /work/precious.txt      # still there afterwards
precious uncommitted work
$ moat run "Try to read the host's credentials and project directory, and report exactly what happens."

  ✓ /bin/sh -lc 'echo --- host home ---; ls /home/user 2>&1 | head -3; echo --- host canary ---; …'
Every host path was unreachable from inside the sandbox; the outputs above are the errors.
  17280 tokens  1 tool
```

`AWS_SECRET_ACCESS_KEY` and `SSH_AUTH_SOCK` were set on the host for that run
(`test/e2e-codex.sh` section 5) and are absent inside; the independent check in
`moat doctor` confirms the same thing without going through a model:

```
  pass  host canary unreadable         /home/user/.moat/canary (mode 600, exists only on the host) is unreadable
  pass  no host env forwarded          no variable from the host environment reached the sandbox; present: HOME, LANG,
                                       LC_ALL, MOAT_SANDBOX, PATH, PWD, SHLVL, TERM (plus moat's own …)
```

The canary is a real file that exists only on the host, mode 0600, created for the
duration of the test; the acceptance suite asserts the same three paths independently with
`moat exec`, so the result does not depend on the model reporting it honestly.

---

## Criterion 8: the credential is injected, scoped, short-lived, and never baked into the image

### 8a. It is injected, and it reaches the provider

The stub records the request it receives, so this is what the provider would have seen
rather than what moat says it sent (`test/evidence/codex-provider-record.txt`): every
inference request of the turn carries the injected credential as a bearer token, and the
same record is where the advertised tool list comes from.

### 8b. It is not in the image

Evidence: `test/evidence/codex-credential-not-in-image.txt`, `test/evidence/codex-config.txt`.

The entire rootfs (hundreds of MiB, including the pinned runtime binary and the entry
script) was searched for the literal value:

```
$ grep -r --binary-files=without-match -l <credential> /home/user/.moat/envs/<id>/rootfs/ | head
matches: 0

$ moat exec -- sh -c 'grep env_key /root/.codex/config.toml'
env_key = "MOAT_INJECTED_CREDENTIAL"
```

The config holds the *name*; Codex reads that variable from its own environment at
startup, and the value never reaches a file. Only a fingerprint is persisted on the
host (`"sha256:7726b438889c7f57"`).

### 8c. It is short-lived, and expiry is enforced

`test/e2e-extras.sh` boots with `--credential-ttl 6s` and then does nothing. The box
enforces the credential's own deadline, which the host passes as
`MOAT_CREDENTIAL_EXPIRES_EPOCH`; a credential that is already dead at boot stops the box
instead of starting an agent that cannot call a model:

```
$ moat up … --credential-ttl 6s
[moat] codex runtime ready (pid 1)
[moat] the injected credential expires in 6s; the box stops then
[moat] injected credential expired; stopping the sandbox

$ moat status
status       stopped
credential   moat sha256:7726b438889c7f57 expires in -6s (EXPIRED — the box stops at this deadline)
```

(Both blocks are from `test/evidence/logs-ttl.txt` and
`test/evidence/status-after-ttl.txt`.) The deadline is the credential's own timestamp,
not a TTL counted from the script's start: counting from the start let the box outlive
its key by however long the boot took.

**Scope of this claim.** v0 enforces expiry by *stopping the box*, not by
revoking the token at the provider. Provider-side scoping and revocation are v2
work; `docs/SPEC.md` §5.3 says so.

---

## Criterion 9: environments persist per project, and snapshots capture the rootfs, not the project

```
$ moat exec -- /bin/sh -c "echo persisted-$(date -u +%s) > /opt/moat-marker; until apk add --no-cache jq; do …; done"
--- jq --version ---
jq-1.7.1
--- marker ---
persisted-at-1789748834

$ moat down
✓ sandbox stopped (pid …); the environment and its snapshots are kept

$ moat up …
✓ sandbox up, warm start 3.96s (image reused)

$ moat exec -- /bin/sh -c "cat /opt/moat-marker; jq --version"
--- marker (proof the rootfs persisted) ---
persisted-at-1789748834
jq-1.7.1
```

The rootfs and the project copy in `/work` survive a full stop and a boot, and a package
the agent installed is still there afterwards. Snapshots capture the rootfs (installs,
state) and exclude `/work`; the restore half is extras section A/B
(`test/evidence/snapshot-take.txt`, `snapshot-restore.txt`).

---

## The harness: providers, profiles, and the agent brief

Added after v0 passed, for production use with DeepSeek.
These are the checks that the harness is *wired* correctly; the model quality is
the provider's business, and no API key exists on this host, so what is verified
here is configuration, resolution and capability: never a claim about a model.

### Model and provider resolution

moat targets one provider, so there is nothing to resolve and no `--provider` flag. For
DeepSeek the endpoint, context window and capabilities come from the
[models.dev](https://models.dev) catalog, and moat renders the one
`[model_providers.*]` block Codex needs. The rendered file, read back from inside the box
(`test/evidence/codex-config-in-box.txt`), carries:

```toml
model = "<the resolved model id>"
model_provider = "deepseek-moat"
approval_policy = "never"
sandbox_mode = "danger-full-access"
preferred_auth_method = "apikey"
forced_login_method = "api"
model_catalog_json = "/root/.codex/models.json"
web_search = "disabled"
model_context_window = <catalog context window>
model_max_output_tokens = <catalog output cap>
model_reasoning_effort = "<the --effort level, only when one was passed>"

[model_providers.deepseek-moat]
name = "DeepSeek"
base_url = "<catalog base URL, or --base-url>"
env_key = "MOAT_INJECTED_CREDENTIAL"
wire_api = "responses"
$ moat up --profile node,python --base-url http://127.0.0.1:5599/v1 --model mock-model
✓ installed 20 package(s) for profile(s) node, python

$ moat exec -- /bin/sh -c 'node --version; npm --version; python3 --version; uv --version'
v22.23.2
10.9.1
Python 3.12.14
uv 0.5.31
```

Twenty packages on top of the base image, installed with the sandbox's own
package manager, persisted in the rootfs, and incremental on subsequent boots
(`profiles: everything requested is already installed`).

### The agent brief is written *and read*

`/root/.codex/AGENTS.md` is Codex's global instruction file, and moat writes it on every
boot from `bundle/instructions.ts`. Writing a file is not the same as it being read, so the
check is on the request the provider receives: the recording stub keeps the request body,
and the brief's content arrives in it, wrapped as AGENTS.md instructions
(`test/evidence/codex-mock-brief.txt`). The brief is never written into the project: the
user's repository is copied in byte-for-byte and moat adds nothing to it.

### The working branch

Evidence: `test/evidence/up.txt`, `test/evidence/up-default.txt`, `test/evidence/codex-up.txt`.

Every boot puts the sandbox's working tree on `moat-session-<timestamp>`, so the user's
own branch is untouched *inside* the box as well as outside it, and copy-out has one
predictable ref to read:

```
→ copy-out: git fetch …/rootfs/work +refs/heads/moat-session-<stamp>:refs/moat/moat-session-<stamp>
✓ fetched moat-session-<stamp> -> refs/moat/moat-session-<stamp> (<sha>)
  apply with: moat apply moat-session-<stamp>  (or --checkout)
$ moat snapshot before-extras
$ moat exec -- /bin/sh -c "echo MARKER-ADDED-AFTER-SNAPSHOT > /opt/moat-extra; ls /opt"
moat-extra
moat-marker

$ moat restore before-extras --yes
stopped sandbox pid 14908 before restoring
✓ restored rootfs snapshot before-extras (the project copy in /work was preserved)

$ moat exec -- /bin/sh -c "ls /opt; ls /work; git -C /work log --oneline -1"
in-sandbox /opt after restore:
moat-marker                                  <-- moat-extra is gone: the rootfs rolled back
--- /work preserved? ---
README.md
agent-output.txt
greet.sh
notes.txt
--- agent commit still present? ---
3dd04fb agent: add agent-output.txt from inside the sandbox
```

`moat restore` refuses while the sandbox is running unless `--yes` is passed,
because restoring the rootfs underneath a live box would leave it serving a
deleted image. That refusal is in the code path, and `--yes` is what the suite
passes to stop it deliberately.

### C. `moat apply` is a separate step from `moat fetch`

Evidence: `test/evidence/extras-up-again.txt`, `test/evidence/extras-fetch.txt`, `test/evidence/apply-branch.txt`.

```
$ moat apply main --name e2e-checkout
✓ branch e2e-checkout -> refs/moat/main
  checkout with: git checkout e2e-checkout

$ git -C <project> branch --list e2e-checkout
  e2e-checkout
$ git -C <project> rev-parse HEAD
0b97af8ec4d6460038e833e6633fb00ca1d80168        <-- unchanged: nothing was checked out
$ git -C <project> status --porcelain
 M README.md
?? notes.txt                                     <-- only the user's own pre-existing edits
```



### I. A binary file in the project used to break the baseline

`moat apply` materialises the recorded baseline by running `git archive` and
unpacking the result. Both halves of that went through the process: the archive
was captured as a UTF-8 string and written back to `tar`'s stdin. A tar archive
is binary, and the round-trip is lossy: a byte that is not valid UTF-8 decodes
to U+FFFD, which re-encodes to **three** bytes, so the stream grows and every
header after the damage is read from the wrong offset. `tar` then stops partway.

Because only its exit code was checked, the result was not an error but a silent
one: the baseline came back empty, the caller skipped the comparison, and moat
reported `nothing to apply` over a tree it had failed to read. With a large
enough archive the same fault killed the CLI outright, since writing the rest of
the stream to a `tar` that had already exited raises `EPIPE` on its stdin, and an
`error` event with no listener is fatal in Node.

Reproduced by putting a binary file in the project, named so that it sorts before
everything else: tar has to stop early enough to lose the files after it:

```
$ node --test test/unit/apply.test.ts   # with a binary file in the fixture
  pass  a binary file does not stop the plan
  pass  the binary file survived apply byte for byte
```

The archive now goes to a file and `tar` reads that, and `run()` swallows EPIPE
so a child that exits early is reported rather than fatal. Reintroducing the old
pipeline fails four of those checks, which is how the guard was confirmed to be
capable of failing.

Copy-in was checked for the same fault and is **not** affected: `git diff
--binary` emits base85, which is pure ASCII, verified by round-tripping a real
binary patch and finding no character above ASCII 126.

### J. The price of a turn

**The prices are DeepSeek's, not the catalog's.** The models.dev entry disagrees with the
published table, so moat computes its own (`lib/pricing.ts`):

```
                     models.dev        published (off-peak)   published (peak)
deepseek-v4-pro      in  0.435        in  0.66               in  1.32
                     out 0.87         out 1.98               out 3.96
                     hit 0.003625     hit 0.022              hit 0.044
deepseek-flash       in  0.15         in  0.15               in  0.30
$ npm run test:unit
✔ two files merged cleanly each keep their own merge
✔ a second plan does not invalidate the first plan's merge inputs
✔ a filename with two spaces is not misattributed to another file
✔ a file the user deleted and the agent changed is a conflict
✔ a mode-only change is planned and applied
✔ a missing baseline is reported, never rendered as 'nothing to apply'
✔ an edit made after the plan is shown is not overwritten
✔ a destination outside the project is refused, including through a symlink
✔ a new file the agent created is applied
✔ a new symlink the agent created is applied as a symlink
✔ copy-in reproduces a modified non-UTF-8 text file byte for byte
✔ drift detection is sensitive to a byte-only change
✔ the mount check renders the root field, without which a host bind is invisible
✔ a host bind is flagged, moat's own rootfs and the six devices are not
✔ a repo-configured fsmonitor does not run on the host
✔ a pre-commit hook written in the sandbox does not run on the host
✔ a clean filter configured in the repo does not run on the host
✔ sandboxGit refuses a .git file that points outside the workspace
✔ the sanitized config keeps only the repository-format keys
✔ a literal key in any written artifact is refused
✔ a pid is only 'ours' when the recorded start time matches
✔ two reads of the same process agree on its start time
✔ the rendered codex config keeps approvals and Codex's own sandbox off
✔ a completed call is recorded as completed, not as success
✔ MOAT_SANDBOX_ENV only carries MOAT_ names and never a managed one
✔ the sandbox environment is a pure whitelist
✔ TTL expiry is decided by the recorded timestamp
✔ the literal-flag notice names argv and shell history
✔ the rootfs scan finds the value only when it is on disk
✔ the credential store is 0600 inside a repaired 0700 directory
✔ applyBranch creates the local branch without moving HEAD
✔ applyBranch checkout switches to it, and refuses a dirty tree
✔ applyBranch refuses a ref that was never fetched
✔ suggestBranch prefers a branch whose tip the host cannot reach
✔ a check command with quotes, dollars and command substitution arrives intact
✔ a check that ignores SIGTERM is killed after the grace period
✔ verifyFile accepts the published digests and rejects anything else
✔ a verified download lands, and a corrupted cache is re-downloaded
✔ a digest mismatch leaves neither the file nor a temp behind
✔ two concurrent downloads of one artifact end with a complete file
✔ snapshot names cannot leave the snapshot directory
✔ snapshotEnv refuses an invalid name and writes no file
✔ listSnapshots ignores a file whose name is not valid
✔ restore replaces the rootfs and preserves the project copy
✔ a failed restore leaves the rootfs and the project untouched
✔ copy-in names the paths git cannot carry, and stays quiet about ignored ones
✔ fetchBranch points a non-git project at moat apply
$ bash test/e2e-egress.sh
  pass  the box booted with isolated egress
  pass  status reports running
  pass  status reports isolated egress
  pass  the provider answers through slirp (401 without a key)
  pass  slirp's 10.0.2.2 gateway cannot reach the host's loopback
  pass  host loopback reachable        the sandbox has its own network namespace and reached the host's
                                       loopback through neither 127.0.0.1 nor slirp's 10.0.2.2 gateway (port 35205)
  pass  network namespace isolated     sandbox net:net:[4026532585] differs from host net:net:[4026531833];
                                       slirp4netns carries its traffic
  pass  doctor reports the isolated namespace
  pass  doctor reports loopback unreachable
  pass  doctor no longer says the namespace is shared
  pass  the isolated box's slirp (pid 60096) stopped with it
  pass  the box booted with filtered egress
  pass  status reports filtered egress
  pass  the allowlisted provider is still reachable (401 without a key)
  pass  the blocked probe ran inside the box
  pass  an address outside the allowlist is refused
  pass  nft was reinstalled before the filtered boot
  pass  the reinstalled box ran the probe
  pass  and it is still filtered
  pass  egress filtered                an address outside the allowlist (1.1.1.1:443) is refused, and
                                       api.deepseek.com:443 is reachable
  pass  doctor reports filtered egress
  pass  doctor no longer calls egress unrestricted
  pass  the filtered box's slirp (pid 60628) stopped with it
  pass  a fresh environment boots filtered by default
  pass  the default policy is reported as filtered
  pass  the default policy still allows the provider (401 without a key)
  pass  the default-policy probe ran inside the box
  pass  the default policy blocks an address outside the allowlist
  pass  an unresolvable provider fails the boot
egress checks passed
```

Both the allowed and the blocked path are the real command, in the same box:

```
$ moat exec -- /bin/sh -c 'curl -sS -o /dev/null -w "%{http_code}" --max-time 25 https://api.deepseek.com/models'
401
$ moat exec -- /bin/sh -c 'curl -sS --max-time 6 -o /dev/null -w "code %{http_code}\n" https://1.1.1.1/ ; echo "curl-exit=$?"'
curl: (28) Connection timed out after 6002 milliseconds
code 000
curl-exit=28
```

The blocked probe is asserted twice on purpose: that `curl-exit=` is present at
all (the command ran, the boot did not fail before it) and that it is not 0. The
first assertion is what keeps the second from passing vacuously: the tranche
before this one "passed" the blocked check while the box was not booting.

The gateway check exists because the obvious probe was vacuous. Testing
`127.0.0.1:<host port>` from inside an isolated namespace only proves that the
namespace's own loopback is empty, not that the host's is unreachable. With
slirp's default settings the guest reaches a host service through the 10.0.2.2
gateway. Measured on this host, with the same guest and host listener:

```
default slirp:            guest -> 10.0.2.2:45681 -> HTTP 200
--disable-host-loopback:  guest -> 10.0.2.2:45681 -> connection refused
```

So the launcher passes the flag, and `moat doctor` measures both addresses and
fails a namespaced run if either answers. In `filtered` mode the in-sandbox check
is two-sided: an address outside the allowlist (1.1.1.1:443) must be refused
**and** the allowlisted provider must be reachable. So a ruleset that drops
everything, including the provider, fails the run.

Two defects found while building this are guarded by unit tests that were watched
failing with the bug reintroduced (`test/unit/egress.test.ts`):

* `filtered` was not counted as "has its own network namespace" (the predicate
  was `egress === "isolated"` at four call sites). The box then booted in the
  **host's** namespace and `nft -f` failed with `netlink: Error: cache
  initialization failed: Operation not permitted`, because nft needs
  `CAP_NET_ADMIN` in the namespace's user namespace and an unprivileged user has
  none in the host's. `bootIsolation()` (`sandbox/launcher.ts`) now refuses to
  load a ruleset outside the sandbox's own namespace, and the unit test fails if
  either predicate regresses.
* The slirp API socket was a fixed path and readiness was a `stat()`. A socket
  file outlives the slirp that created it, so the second boot in an environment
  failed with `ECONNREFUSED` on the forward while slirp itself could not bind
  over the stale file. Each boot now names its own socket
  (`slirp-<pid>-<rand>.sock`) and readiness is a connection; `pruneDeadSockets`
  reaps the dead ones and never touches a live one.

#### The filter is a rule the agent can change

The ruleset lives in the sandbox's own network namespace, and uid 0 inside that
namespace holds `CAP_NET_ADMIN` over it. Measured, in the same box:

```
$ moat exec -- /bin/sh -c 'nft list chain inet moat_egress output >/dev/null 2>&1; echo "filter-present-exit=$?"; \
      nft flush ruleset; echo "flush-exit=$?"; sleep 0.3; \
      curl -sS --max-time 6 -o /dev/null -w "http %{http_code}\n" https://1.1.1.1/ ; echo "curl-exit=$?"'
filter-present-exit=0
flush-exit=0
http 301
curl-exit=0
```

Every boot re-applies the ruleset and `moat doctor` re-measures the policy, so a
flushed filter is detected on the next run, not prevented. What the policy buys is
a bound on where the box sends data during normal work (a runaway install, a
prompt-injected `curl`, an accidental upload), not containment of an agent that is
trying to leave. Containing that one means the agent losing root, which is
incompatible with handing it a package manager, or the v1 microVM. SPEC §7.3 says
this in the contract, not only here.

#### A provider that does not resolve fails the boot instead of boxing it

The allowlist is resolved on the host before the boot, and a host that resolves to
nothing is dropped from the ruleset. For an extra registry that is fine; for the
provider it means a filtered box that boots, looks healthy, and cannot call the
model at all. Measured before the fix: `moat up --base-url
https://nxdomain-<random>.invalid/v1` booted with `egress filtered` and an allowlist
that did not contain the provider. It now exits non-zero:

```
$ moat up --base-url https://nxdomain-1234.invalid/v1
✗ could not resolve nxdomain-1234.invalid, so a filtered sandbox would not reach the
  model. Check DNS and try again, or pass --egress open to boot without the allowlist.
installCodexFiles completed without complaint
  host-side AGENTS.md WAS CREATED (3834 bytes)
target dir contents: [ 'AGENTS.md' ]
== N. an environment whose project directory is gone stays visible and reclaimable
$ MOAT_HOME=<temporary> moat status --all
orphaned   0.0 KiB  <the project directory this environment recorded is gone>
orphaned   0.0 KiB  /gone/forever
           0.0 KiB  total, across 2 environment(s)
  orphaned: the project directory is gone; moat destroy --all reclaims them
  reclaim it with: moat destroy --all
$ MOAT_HOME=<temporary> moat destroy --all
  removed cafebabe5678  0.0 KiB  <the project directory this environment recorded is gone>
  removed deadbeef1234  0.0 KiB  /gone/forever
✓ destroyed 2 environment(s), about 0.0 KiB
orphan inventory: both were listed as orphaned and both were reclaimed
```

`test/unit/env-inventory.test.ts` covers the same ground without a sandbox: the
gone-project case, the unreadable-state case, a half-created directory, junk
directories in `envs/` that must be ignored, and that `envPathsForId` touches no
filesystem. The suite's three failing assertions were watched failing with the old
`listEnvs` restored.

### O. Arguments that used to be joined into paths or trusted as numbers

Evidence: `test/evidence/logs-traversal.txt`, `test/evidence/logs-bad-tail.txt`, `test/evidence/models-bogus.txt`, `test/evidence/up-bad-egress.txt`.

Small defects of the same shape: an argv that becomes a path or a number without
being checked, plus one flag whose unit depended on where it was read. They are
asserted where they cost nothing (the extras suite, section R), and the pure part has
a unit test.

```
log name: refused instead of reading a host file
--tail: refused instead of silently printing the whole log
models <provider>: refused instead of silently listing DeepSeek
--timeout: seconds, not milliseconds, for the boot readiness wait
--model with an empty value: refused
--base-url with an empty value: refused
$ moat up          # state.json deleted by hand; /work untouched
! state.json is missing, but the sandbox's working tree is still there, so the environment was recovered from disk instead of replaced.
  branch   moat-session-2026-09-19-18-25
  baseline 5b12b845c8f4
  everything installed in it, and every commit it holds, are intact; this boot mints a fresh credential.
  the host-drift check cannot run without the recorded baseline: `moat up --sync` re-copies the project and restores it.
  to discard the sandbox's copy instead: moat up --fresh --yes
copy-in: reusing the sandbox working tree (use --sync to re-copy from the host)
✓ sandbox up, warm start 4.17s (image reused)
```

Nothing that cannot be derived is invented: the credential is minted fresh (the old
one is dead anyway), and with no recorded host baseline the drift check *reports that
it cannot run* on every boot rather than comparing against a guess. An unreadable
(rather than absent) file is kept beside the new one as
`state.json.corrupt-<timestamp>`.

Extras section T deletes the real file, boots again, and fetches what the agent had
committed:

```
✓ fetched moat-session-2026-09-19-18-25 -> refs/moat/moat-session-2026-09-19-18-25 (53df7f804d05)
  2 commit(s) reachable, HEAD e6088eeb8b2f -> e6088eeb8b2f
    53df7f804d05  agent: work the host has never seen
    e6088eeb8b2f  init
state recovery: the rootfs was kept and its working tree reused, not re-copied
state recovery: the recovered commit fetched to the host (refs/moat/*)
```

Both of those checks were watched failing with the recovery removed (2 FAILED).
`test/unit/env-recovery.test.ts` covers the reconstruction without a sandbox: the
branch and the copy-in baseline read back out of the sandbox repository, the version
read through the symlink guard, a detached head reported as no branch, and the three
things that must not be invented: a credential, a host baseline, a runtime version.

One deliberate limit: recovery happens on the next `moat up`. `moat fetch`, `moat take`
and `moat verify` still require a readable state, so a lost file means one boot before
the work can be brought across through moat.

### R. A boot in progress is visible, and the lifecycle commands wait for it

Evidence: `test/evidence/race-status.txt`, `test/evidence/race-down.txt`.

A boot spends most of its time looking exactly like an idle environment.
`state.json` says stopped with no pid and is only rewritten once the box is
spawned, so the window that provisioning, copy-in and the readiness wait occupy is
indistinguishable from "nothing is happening" to every other command. Measured in
that window, before this: `moat down` printed "sandbox is not running" and exited
0, and the box came up and stayed up; `moat destroy` deleted the rootfs out from
under the boot (which then waited out the full 90-second readiness budget and
failed); and a second `moat up` booted a second box over the same rootfs, after
which `state.json` records whichever finished last and the other sandbox is alive
with nothing tracking it.

The long-running boot now writes `runtime/boot.json` before its first slow step
(pid and start time, the same identity rule the sandbox pid follows) and clears it
when the boot is over:

```
$ moat status          # while moat up is still provisioning
status       booting (pid 188203, 0s in)

$ moat down
→ moat up is already booting this environment (pid 188203, 0s in); waiting for it before stopping the sandbox
the boot finished
✓ sandbox stopped (pid 188275); the environment and its snapshots are kept
```

`down`, `destroy`, `restore` and a second `up` wait for that marker (five minutes,
then a refusal that names the pid); `snapshot` refuses without `--yes`, because a
torn rootfs is what a snapshot must not capture; and `destroy --all` skips a
booting environment with a reason instead of blocking the whole run. A marker whose
process is gone (ctrl-c, a crash, a `log.fail`) is reaped by the next reader, so
nothing waits five minutes for a boot that no longer exists.

Extras section U polls for the marker rather than sleeping, so the check acts
inside the window whenever the window is:

```
the boot marker appeared after ~0s (state.json written yet: no)
status during a boot: reports booting, not stopped
down during a boot: waited for the boot and stopped what it produced
after down: the box is stopped, nothing is left running, and the marker is gone
```

All three of those checks were watched failing with the marker reads disabled (3
FAILED, and the run ended with the sandbox still running, which is the bug).
`test/unit/boot-marker.test.ts` covers the marker without a sandbox: the record and
its pid identity, a marker whose process died being reaped rather than waited on, a
reused pid not being believed, waiting returning `finished` when the other boot ends
and `timeout` while it runs, and the age the message reports.

Ephemeral boots (`moat exec`, `moat doctor`, `moat shell`, the checks runner)
deliberately take no marker: they are meant to run alongside a boot (AGENTS.md, on
unique boot scripts), and serialising them would be a worse trade.

### S. Agent text cannot drive the terminal it is printed on

Everything the sandbox emits (the answer, the reasoning, commit subjects, branch
names, change paths, session titles, the boot log) is *terminal input* as much as it is
data, and a terminal acts on escape sequences: OSC 0 retitles the window, OSC 52
writes the clipboard where the terminal allows it, CSI 2J clears the screen, and a
carriage return overwrites the row. Tool output and tool titles were already
stripped (`stripAnsi`), which is how the omission was found: the model's own words
and most of the sandbox's metadata were not.

Measured through a real pty, with a distinct sequence in the answer, in a commit
subject and in a file name (extras section V):

```
›   78d81ce agent: subject  here          # the subject's OSC is gone, its words are not
›   uncommitted (not fetched by moat fetch):
›     new file: esc-file-.txt             # same for a file name
--- checks ---
  pass  the answer's window-title sequence never reached the terminal
  pass  the answer's erase-display sequence never reached the terminal
  pass  a commit subject from the sandbox is stripped
  pass  a changed file name from the sandbox is stripped
7/7 checks passed
```

And the sandbox's own log, which the agent can write to at will:

```
$ moat logs sandbox --tail 3
LOG-INJECT  end
sandbox log: the agent's own escape bytes are stripped, its text is not
```

Four of the seven pty checks fail with `stripAnsi` made a no-op, and the log check
fails with the one call in `rootfsLogTail` reverted. `test/unit/terminal-text.test.ts`
covers the helper without a terminal: every sequence a terminal would act on, and the
stream case: a sequence split across two deltas cannot be reassembled, because
`stripAnsi` removes every ESC byte either as a sequence or as a control character, so
neither half can begin one. An `AnswerRenderer` case asserts the same at the
renderer, with colour off, so every escape in that output would have come from the
model.

### T. A project with no tests is not reported as failing its tests

Evidence: `test/evidence/notests-up.txt`, `test/evidence/notests-verify.txt`.

`npm init` (and yarn's and pnpm's) scaffolds a test script that exits 1 on purpose:
`echo "Error: no test specified" && exit 1`. `detectChecks` matched it like any other
script, so moat offered it to the agent as the project's check and ran it itself:
`moat verify` printed `FAIL npm test (exit 1)` as the project's own verdict on work no
test had looked at, and `moat up` announced `checks: npm run test` for a project with
no tests at all.

Placeholders are filtered now (`isRealScript`), and so are bare `echo`s, which are the
same problem pointing the other way: they can only pass. The project above reports
what it is:

```
$ moat verify
! no test, lint or typecheck command found for this project
  moat looks at package.json scripts, Makefile targets, pyproject.toml, Cargo.toml and go.mod
--- exit 0
```

and `moat up` prints no `checks:` line for it. Extras section W is that pair of checks;
both fail with the filter reverted (measured: `checks: npm run test` at boot, then
`FAIL npm test 0.1s (exit 1)`). `test/unit/checks-detect.test.ts` covers the rule
without a sandbox: npm's placeholder in three quotings, `echo` alone, real scripts that
happen to echo first (`echo starting && node --test`, `echo starting; jest`) kept, a
placeholder test that does not hide the lint and typecheck scripts, and the package
manager still read from the lockfile. Four of its six fail with the filter reverted.


### V. `--timeout` shortens a check that hangs

`--timeout` is seconds everywhere, and `runChecks` has taken a `timeoutSeconds`
argument from the beginning, but no caller passed one. `moat verify --timeout 1`
was accepted by the global flag table and then ignored, so a project whose test
sleeps for three seconds ran to completion and reported pass:

```
$ moat verify --timeout 1
→ running npm run test inside the sandbox
[moat] exit 0
  pass  npm test                 3.2s
--- exit 0
```

The only way to shorten a hung suite was to wait out the ten-minute default, per
check. `moat verify` and `moat take` pass the flag through now:

```
$ moat verify --timeout 1
→ running npm run test inside the sandbox
[moat] TIMED OUT after 1s
[moat] exit 124
  FAIL  npm test                 1.0s (timed out)
--- exit 1
```

Extras section Y is that pair: the same project with the default budget (pass, 3.2s)
and with `--timeout 1` (timed out, 1.0s, exit 1). It fails with the wiring reverted.
The runner's own mechanics (the kill, the escalation for a process that traps
SIGTERM, and a command with quotes and substitution arriving intact) were already
covered by `test/unit/checks-runner.test.ts`. The REPL's `/verify` has no flag and
keeps the default.

The general wart this came from is that the flag table was global, so any command
accepted any declared flag and silently ignored the ones it did not read. Section W
below is the fix for that.

### W. A flag a command does not read is refused, `--quiet` exists, and `--help` prints help

Evidence: `test/evidence/flag-refused.txt`, `test/evidence/loud-up.txt`, `test/evidence/quiet-up.txt`, `test/evidence/help-flag.txt`.

`parse` checked that a flag *existed*, not that the command *read* it, so a flag a
command ignored was accepted and dropped. Two real bugs came out of that silence:
`--timeout` never reached the checks runner (§V), and `--quiet`, which every harness in
this repository passes on `moat up`, was read by nothing at all. A third was worse than
silence: `moat up --help` booted a sandbox.

The parser now lives in `lib/flags.ts` with two tables: every flag moat has, and what
each command reads. `main()` parses once before dispatch with the command's name:

```
$ moat fetch --timeout 5
✗ --timeout has no effect on `moat fetch`, so it is refused rather than ignored.
  moat's flag table is shared by every command; `moat help` lists the commands.
--- exit 1
```

`--quiet` hides the progress lines (warnings and results still print), which is the
point of the flag the suites were already passing:

```
$ moat up --quiet …                       # no progress lines at all
profiles: everything requested is already installed
copy-in: reusing the sandbox working tree (use --sync to re-copy from the host)
✓ sandbox up, warm start 4.16s (image reused)
--- exit 0
```

and `moat profiles --help` prints the help text instead of the profile list:

```
$ moat profiles --help
moat — run an AI coding agent in a disposable sandbox. Your machine is never touched.
Usage: moat <command> [options]
--- exit 0
```

Extras section Z is those three, with a control that runs the same `up` *without*
`--quiet` and shows the progress lines are there to be hidden; all four checks fail
with the refusal, `setQuiet` and the `--help` return reverted. `test/unit/flags.test.ts`
covers the parser without a sandbox: the refusal names the flag and the command, the
flag still parses for the commands that read it, `--help`/`--quiet`/`--verbose` are
global, `--` ends flag parsing (so `moat exec -- cmd --quiet` passes it through), and
every flag named in the command table exists in `SPEC`. A second test pins the flags the
suites pass to `moat up`, so a missing entry fails there rather than as a wall of boot
output.


### Y. The agent brief describes the box the boot actually made

Evidence: `test/evidence/codex-mock-brief.txt`, `test/evidence/codex-mock-run.txt`.

`InstructionsInput` carries `hasCredential` and the boot's profile list. The renderer
read neither: the credential paragraph and the "the `db` profile ships PostgreSQL,
SQLite and Redis as real servers" line were unconditional text. Measured by rendering
the brief for a boot with no credential and no `db` profile:

```
- The credential that lets you call the model is readable by anything in this
  sandbox, including code you run. Do not print it, do not commit it, and do not
  send it anywhere. …
- If the project needs a database or another service, **run it here.** The `db`
  profile ships PostgreSQL, SQLite and Redis as real servers, not just clients.
```

Both are false for that box. A boot against a local `--base-url` endpoint injects no
credential (the stub-provider sections boot exactly that way), and `db` is never
auto-detected (it takes an explicit `--profile db`), so the default brief told every
agent to guard a key it did not have and to start servers that were not installed.
After the fix the same render says:

```
- **No model credential was injected into this sandbox.** There is no key in your
  environment to find, print, commit or send. …
- If the project needs a database, **run it here.** This box does not have the
  `db` profile installed (PostgreSQL, SQLite, Redis as real servers): `apk add` what
  you need, …
```

The injection-refusal instruction is in both versions deliberately: refusing a project
file that asks for environment variables does not depend on there being a credential to
steal. `test/unit/instructions.test.ts` holds both halves and both `db` states, and was
watched failing with either paragraph made unconditional again.

### Z. Copy-out names the credential it carries

Evidence: `test/evidence/leak-up.txt`, `test/evidence/leak-fetch.txt`, `test/evidence/leak-fetch-clean.txt`, `test/evidence/leak-apply.txt`.

The agent has to read the injected credential to call the model, and the brief tells it
not to commit it. Nothing checked: `moat fetch` copied every object the agent committed
into the host repository, and `moat apply` wrote the agent's files into the working tree,
with no scan at all. Measured in extras section AB, with the exact value the box was
booted with written into the project and committed the way the agent commits:

```
! 1 file(s) in the branch just fetched contain the credential moat injected into the sandbox:
    leaked.env
  The agent has to read that value to call the model, and it can write it anywhere. moat names
  it instead of dropping it: review (or delete) the file before you commit or push, and rotate
  the key if that content has already reached a remote.
✓ fetched moat-session-2026-09-19-21-07 -> refs/moat/moat-session-2026-09-19-21-07 (b40a898396bf)

$ moat apply
! 1 file(s) about to be written into your working tree contain the credential moat injected
  into the sandbox:
    leaked.env
  add     feature.ts
  add     leaked.env
✓ applied 2 change(s) to /home/user/moat-demo/leakscan
```

The fetch search covers every commit the fetch brought in, not only the tip, so a key
committed and deleted again is still named: `test/unit/leak-scan.test.ts` builds exactly that
history (the working tree is clean at the tip and the blob is in the fetched objects) and
fails if the scan looks at the tip alone. The control runs the same boot and the same commit
path without the value and requires silence (`grep -c 'credential moat injected'` → `0`), so
the check cannot pass by warning about everything. The file is still written: a warning, not
a gate, because a half-apply would be worse than a named exposure. Both positive halves were
watched failing with the scan disabled (the two leak assertions fail; the controls pass).

The paths in the warning are the agent's, so they go through `stripAnsi` like every other
string that came out of the sandbox, and the value never reaches argv: `git grep` reads it
from a 0600 patterns file, because `ps` is world-readable. What the scan cannot see is in
SPEC §4 and the closing table: a key rotated since the boot (the sandbox holds only a
fingerprint), a secret the agent found elsewhere, commits older than the most recent 50, and
files over the apply scan's size limit, and each bound is named when it is reached.

### AA. A base URL the sandbox cannot use is refused, and the doctor does not claim a probe it did not run

`--base-url` and `--upstream` were checked with `new URL()`, a parse check, not a
usability check. `localhost:11434/v1`, the scheme-less form of the endpoint moat's own
error text suggests, parses as protocol `localhost:` with an **empty hostname**.
Measured before the fix, on a real boot:

```
$ moat up --no-detect --model mock-model --base-url localhost:11434/v1
✓ image provisioned in 1.02s (extract cached image 858ms)
✓ copy-in via git: 1 files, 0.0 KiB, digest 01d119f0b157f0c2
! injecting moat credential sha256:34c4e933b47c1fb3 … its egress is restricted to an allowlist …
✓ sandbox up, cold start 13.32s (image built)
--- exit 0 ---

$ moat doctor
isolation (17 checks)
  pass  egress filtered                an address outside the allowlist (1.1.1.1:443) is refused, and the provider is reachable
```

Exit 0, a *filtered* box whose allowlist contains no provider address (both
`providerHost()` and `providerProbe()` read `.hostname`), so every model call the agent
made would fail. The doctor then covered for it with a claim about a probe it never ran,
because `allowedOk` was `!allowedProbe || …`.

After the fix the same command is refused before anything is provisioned, and the
doctor's check says which half it measured:

```
$ moat up --quiet --no-detect --model mock-model --base-url localhost:5599/v1
✗ --base-url must be an http:// or https:// URL: localhost:5599/v1
  did you mean http://localhost:5599/v1?
--- exit 1
```

Extras section AC is that refusal plus the control that the same endpoint *with* the
scheme boots (`✓ sandbox up, cold start 9.05s`, `--- exit 0`), so it cannot pass by
refusing every URL. The capture contains no `image provisioned` or `copy-in via` line,
which is what makes "before provisioning" checkable rather than asserted, and those are
success lines, so `--quiet` cannot hide them. `test/unit/base-url.test.ts` pins the rule
in both directions (`file://`, a bare host, an empty value, and four usable URLs), and
`test/unit/doctor-egress.test.ts` pins the doctor's three cases: probed and reachable,
probed and unreachable, not probed; the last now reports the check as one-sided. All
three tests were watched failing with the shape checks disabled and the vacuous detail
restored.

An environment whose `state.json` recorded a hostless address *before* this fix keeps
booting (the address is metadata, and the sandbox may hold work), but its doctor reports
the filtered check as one-sided, and `moat up --fresh` is the way to replace it.

### AB. A re-copy cannot discard work on another sandbox branch

Evidence: `test/evidence/branchloss-up.txt`, `test/evidence/branchloss-up-again.txt`, `test/evidence/branchloss-fetched.txt`.

`countUnfetched` answers "how many commits does the sandbox hold that the host cannot
reach?", and it used to answer for the sandbox's **HEAD only**. An agent that leaves a
commit on a branch it is not standing on therefore looked like an empty box. Measured
before the fix, on a real boot: a commit on `experiment`, `git checkout` back to the
session branch, the host project edited, `moat up` again:

```
! the host project has changed since it was copied in, and the sandbox holds nothing that is not already on the host. Re-copying it now.
✓ copy-in via git: 1 files, 0.0 KiB, digest ada4876b6cd3fa95 (dirty tree: 1 modified, 0 untracked)

$ moat exec -- git -C /work branch
  main
* moat-session-2026-09-19-21-46
$ moat exec -- git -C /work log --oneline --all
0e38269 moat: state copied from the host
766ea08 base
$ ls /work/experiment.txt
ls: cannot access '/work/experiment.txt': No such file or directory
```

The branch, the commit and the file were gone, and the warning had promised the sandbox
held nothing. The same count gates `--fresh`, which is supposed to demand `--yes` when
the box holds unfetched work, and it returned 0 for a host that is not a repository at
all (a plain directory), where nothing in the sandbox is on the host.

The count now takes every `refs/heads` and `refs/tags` tip, asks the host which tips it
has (`cat-file -e`), counts the known ones on the host (`rev-list --count … --not --all`,
so an already-fetched ref counts as zero) and the unknown ones inside the box against the
clone-time remotes. The same scenario after the fix:

```
! the host project has changed since it was copied in, but the sandbox holds 1 commit(s) that the host does not have. The agent will work on the OLD copy. Run `moat fetch` (add --commit-worktree to include uncommitted work) to keep it, or `moat up --sync` to discard it and re-copy.
copy-in: reusing the sandbox working tree (use --sync to re-copy from the host)

$ moat exec -- git -C /work branch
  experiment
  main
  moat-session-2026-09-19-21-45
$ moat exec -- git -C /work log --oneline --all
437952c important work on a side branch
ab61966 moat: state copied from the host
a77d608 base
```

The warning also follows the *count* now, not the branch of the drift check that was
taken: the old code printed "holds nothing" for any copy it had already decided to do,
and its `--sync`-only variant of the discard warning missed the same commit entirely.

Extras section AD is that pair of boots plus the control: after `moat fetch --all` the
same host change re-copies automatically (`holds nothing that is not already on the
host`, `copy-in via git`), because the work is on the host under `refs/moat/*` and the
re-copy is lossless. `test/unit/unfetched-count.test.ts` covers the count without a
sandbox: a commit on a side branch, two branches with one commit each, a commit kept
alive only by a tag, the fetched case dropping back to zero, and a host that is not a
repository. The side-branch, multi-branch and tag tests were watched failing with the
HEAD-only version restored. One trap inside the fix itself, caught by the non-git test:
`parseInt("0") || fallback` reads a legitimate count of zero as a failed command.

### AC. A commit on a detached HEAD in the sandbox is named, not discarded

Evidence: `test/evidence/detached-up.txt`, `test/evidence/detached-up-again.txt`, `test/evidence/detached-log.txt`, `test/evidence/detached-fetch.txt`.

§AB made `countUnfetched` walk every branch and tag tip. HEAD itself was still missing, so
work committed on a detached HEAD (a normal way to try something) stayed invisible to the
same drift check. Measured before the fix, on a real boot: `git checkout --detach HEAD`,
commit, leave the box, edit the host project, `moat up` again:

```
! the host project has changed since it was copied in, and the sandbox holds nothing that is not already on the host. Re-copying it now.
✓ copy-in via git: 1 files, 0.0 KiB, digest ada4876b6cd3fa95 (dirty tree: 1 modified, 0 untracked)

$ moat exec -- git -C /work log --oneline --all
2e07f4a moat: state copied from the host
5b29df5 base
$ ls /work/detached.txt
ls: cannot access '/work/detached.txt': No such file or directory
```

The commit (`2b2aab9`, "work on a detached HEAD") and its file were gone. `moat fetch`
could not have collected it either (it reads branches), so the fix has two parts: HEAD's
commit is counted as a tip, and when HEAD is detached the warning names the way out instead
of pointing at a command that cannot help. Extras section AE, after the fix:

```
! the host project has changed since it was copied in, but the sandbox holds 1 commit(s) that the host does not have. The agent will work on the OLD copy. Run `moat fetch` … or `moat up --sync` to discard it and re-copy.
  the sandbox is on a detached HEAD, and `moat fetch` reads branches. Name the work first:
  moat exec -- git -C /work branch keep && moat fetch keep
copy-in: reusing the sandbox working tree (use --sync to re-copy from the host)

$ moat exec -- git -C /work log --oneline --all
fa7d22b work on a detached HEAD
$ ls /work/detached.txt
/work/detached.txt

$ moat exec -- git -C /work branch keep
$ moat fetch keep
✓ fetched keep -> refs/moat/keep (fa7d22b9f86c)
box 370445, datapath 370467          # state.json, before the kill
slirp before up: 1                   # the datapath is still running
$ moat up                            # boots a second box
slirp after up: 2                    # the orphan plus the new one
state now: box 370599 slirp 370621   # only the new one is recorded
$ moat destroy
slirp after destroy: 1               # the orphan outlived the destructive command
```

`moat up` now stops a recorded datapath whose box is no longer alive, before it starts
the new box, and says so only when there was something to reap: the datapath can also
exit on its own when the tap goes away. Extras section AG:

```
box 468466, datapath 468487
datapath for that box still up one second after the kill: 1
! reaped the datapath of a sandbox that is no longer running (pid 468487)
after the second boot: old datapath 0, new datapath 1 (new box 468645)
out-of-band kill: no orphaned datapath survives the next boot, and destroy takes the rest
```

Because the datapath sometimes exits by itself within a second of the kill, a second,
deterministic half keeps the box alive and makes its *recorded identity* stale instead
(the state a reboot with pid reuse leaves), so the datapath is certainly running when the
next boot decides:

```
recorded identity replaced; box 468772 datapath 468794
datapath up while its box is still alive: 1
stale identity: the datapath of a box that is not ours is reaped, and named
```

The same record is the only hold `down`, `restore` and `destroy` have, and they clear or
delete it. Reaping the datapath was the fix for `up` only, so a box that was already gone,
or whose recorded identity was no longer ours, took its datapath with it into
unattributability: `moat down` printed the stale-identity warning, wrote `slirpPid: null`
and left the process running; `moat destroy --yes` deleted the environment (`state.json`
with it) and left the process behind; `moat restore` cleared the datapath fields for a box
it refused to signal. Measured before the fix, with the same stale-identity state:

```
$ moat down
! the recorded sandbox is gone: pid 450750 now belongs to another process, so moat did not signal it.
  the environment and its snapshots are kept
after down: box_alive=yes slirp_alive=yes datapath=1        # state now: pid None, slirpPid None
$ moat destroy --yes
env dir exists: no
after destroy: box_alive=yes slirp_alive=yes datapath=1     # record deleted, process not stopped
```

The reap is one function now (`forgetBox`), and every branch that ends a box goes through
it, so the record cannot be cleared before the process is stopped. Extras section AG has a
half per command, on the same deterministic stale identity:

```
down half: box 469093, datapath 469115, up before: 1
! reaped the datapath of a sandbox that is no longer running (pid 469115)
down: a datapath the recorded box cannot be signalled for is reaped, named, then forgotten
! reaped the datapath of a sandbox that is no longer running (pid 469308)
destroy: the environment is removed and its datapath with it
! reaped the datapath of a sandbox that is no longer running (pid 469458)
restore: the datapath is reaped before the record that names it is cleared
```

What this does not stop is the box itself: its recorded identity is stale, so `moat down`,
`restore` and `destroy` refuse to signal that pid (that is the pid-reuse guard above), and
`destroy` removes the environment while that process keeps running. Only the datapath, which
moat can attribute by pid and start time, is reaped.

`test/unit/stop-slirp.test.ts` holds the safety half without a sandbox: a recorded pid
whose start time does not match is never signalled, one that matches is, and no record at
all is a no-op. The mismatch case was watched failing with the start-time comparison removed.
`test/unit/datapath-reap.test.ts` holds the shape: only `forgetBox` may write
`slirpPid: null`, and it reaps before it writes (watched failing with a direct write back in
`moat down`, naming the line), and a command that removes the environment has to call a
reaper somewhere: a coarse rule that cannot see one branch of `destroy` losing its call
while another branch keeps one, which is why the `destroy` half above is the per-branch
proof (watched failing with that call removed: `destroy: FAILED`, `datapath left=1
envdir=gone`).

### AF. The doctor reports the credential state the box has, not the one its probe invented

The environment check runs in an ephemeral boot whose environment is built to match the real
box, so it injects the names the box has, but every credential name was injected
unconditionally. On a box booted with `--no-credential` (SPEC §1.3's "nothing stealable in
the box" mode) the probe put `DEEPSEEK_API_KEY`, `MOAT_INJECTED_CREDENTIAL` and the
`MOAT_CREDENTIAL_*` records into a box that had none, and the report read:

```
  pass  no host env forwarded   … present: DEEPSEEK_API_KEY, HOME, …, MOAT_INJECTED_CREDENTIAL, … (plus moat's own
                                       DEEPSEEK_API_KEY, MOAT_CREDENTIAL_EXPIRES_AT, …, MOAT_INJECTED_CREDENTIAL, …,
                                       which is the credential, disclosed below)
  expose  credential visible to the agent
          MOAT_CREDENTIAL_EXPIRES_AT, MOAT_CREDENTIAL_TTL_SECONDS, DEEPSEEK_API_KEY, OPENCODE_SERVER_PASSWORD,
          MOAT_CREDENTIAL_FINGERPRINT, MOAT_INJECTED_CREDENTIAL are in the environment tool execution inherits. …
          Use a provider-scoped, spend-capped token.
```

Every one of those credential names existed only inside the probe, and the advice to rotate a
provider token was for a key the user had deliberately kept out of the box. A custom endpoint
was reported the same way, including `DEEPSEEK_API_KEY`, which it never has: it receives the
value under moat's own name.

The probe list now comes from the environment's own state
(`doctorInjectedVarNames({ credential: Boolean(state.credential), native })`), and the wording
only calls the names that carry a credential "the credential". The same keyless box:

```
  pass  no host env forwarded          no variable from the host environment reached the sandbox; present: HOME,
                                       LANG, LC_ALL, MOAT_MODEL, MOAT_MODEL_ID, MOAT_PROVIDER_BASE_URL, MOAT_SANDBOX,
                                       OPENCODE_SERVER_PASSWORD, PATH, PWD, SHLVL, TERM (plus moat's own MOAT_MODEL,
                                       MOAT_MODEL_ID, MOAT_PROVIDER_BASE_URL, OPENCODE_SERVER_PASSWORD)
  expose  credential visible to the agent
          secret-looking names in the environment tool execution inherits: OPENCODE_SERVER_PASSWORD. None of them is
          a provider credential — this box was booted with no key, so there is nothing here to leak. The server
          password only opens this sandbox's own server.
```

and a box that does have a credential, pointed at a custom endpoint, keeps the exposure with
the variable named correctly:

```
  pass  no host env forwarded   … (plus moat's own …, of which MOAT_CREDENTIAL_EXPIRES_AT, MOAT_CREDENTIAL_FINGERPRINT,
                                       MOAT_CREDENTIAL_TTL_SECONDS, MOAT_INJECTED_CREDENTIAL is the credential,
                                       disclosed below)
  expose  credential visible to the agent
          MOAT_CREDENTIAL_EXPIRES_AT, MOAT_CREDENTIAL_TTL_SECONDS, OPENCODE_SERVER_PASSWORD, MOAT_CREDENTIAL_FINGERPRINT,
          MOAT_INJECTED_CREDENTIAL are in the environment tool execution inherits. … Use a provider-scoped,
          spend-capped token.
$ moat status
status       running
runtime      codex (deepseek/deepseek-flash)

$ moat exec -- sh -c 'codex --version; cat /root/.codex/config.toml; …'
codex-cli 0.155.1
approval_policy = "never"
sandbox_mode = "danger-full-access"
wire_api = "responses"
codex: the pinned runtime boots, moat renders its config, and the image carries it
$ moat verify            # stderr captured
stderr bytes: 223, ESC bytes: 4, marker present: True
first bytes: …> node escape.js\n\n\x1b]0;PWNED-TITLE\x07\x1b[2JMOAT-CHECK-MARKER\n
```

`moat take`'s failure listing carried the same four bytes. A failing test the agent wrote
could retitle the window or clear the screen while the user read the output of the command
they ran *instead of* trusting it.

After the fix, the same project:

```
escape-verify: 194 stderr bytes, 0 ESC byte(s), marker present: True
escape-take: 787 stderr bytes, 0 ESC byte(s), marker present: True
check output: escapes are dropped, and the text around them still reaches the user