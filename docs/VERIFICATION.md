# Verification

The acceptance criteria, each with the command that produced it and its real
output. Nothing here is paraphrased: the blocks are copied from `test/evidence/`,
which the suites write.

A note on paths: the captured output was produced on the author's machine, and
`/home/<user>` was rewritten to `/home/user` before publication. Nothing else in
any command or its output was altered.

```
bash test/e2e.sh          # criteria 1–9          -> test/evidence/
bash test/e2e-extras.sh   # secondary claims A–E  -> test/evidence/extras.txt
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
  note       mknod denied in userns (kernel policy): /dev nodes are bind-mounted read-only
             from the host's device nodes. No host *data* is mounted.
```

`kvm=no` means `v1` is untestable on this machine, which is why it is out of
scope here. WSL2 is supported via
the container path only".

**On the model.** The acceptance criteria below were produced with a deterministic
local model stub, because this host had no provider credentials at the time:

```
$ env | grep -iE 'api_key|token|anthropic|openai|deepseek|gemini'
(no output)
$ ls ~/.local/share/opencode/auth.json
ls: cannot access '/home/user/.local/share/opencode/auth.json': No such file or directory
```

So the suites drive a deterministic local OpenAI-compatible stub
(`test/mock-model.mjs`) that sits exactly where a real endpoint sits. Everything
inside the sandbox is real: opencode's session engine, its tool dispatcher, its
permission evaluation, its `bash` tool (which runs `/bin/bash` inside the box),
its `write`/`edit` tools, and `git`. What the stub does not test is model
quality. A real DeepSeek session was subsequently run against the same build, 
see "A real model, doing a real task" below, so the stub is no longer the only
evidence.

---

## Exposures, read this before the criteria below

The criteria that follow show a box that protects your host. They do not show a
box that protects your **project** or your **credential**, and it would be
dishonest to let a page of green `pass` marks imply otherwise. `moat doctor`
therefore prints these on every run, in a separate section, sourced from
measurements taken inside a real boot:

```
$ moat doctor

exposures — measured, and NOT fixed in v0. Read these before trusting the box.
  expose  credential visible to the agent
          MOAT_CREDENTIAL_EXPIRES_AT, MOAT_CREDENTIAL_TTL_SECONDS, OPENCODE_SERVER_PASSWORD,
          MOAT_CREDENTIAL_FINGERPRINT, MOAT_INJECTED_CREDENTIAL are in the environment tool
          execution inherits. The bundle blanks secret-looking names for shell commands, but
          the values remain in the opencode process environment and are readable via
          /proc/<pid>/environ. Use a provider-scoped, spend-capped token.
  expose  host loopback reachable
          the sandbox connected to a service the host opened on 127.0.0.1:35367. Every service
          you run locally (databases, dev servers, notebooks) is reachable by the agent.
  expose  egress unrestricted
          the sandbox reached 1.1.1.1:443. The agent can install dependencies AND exfiltrate
          anything it can read, including the project and the injected credential. Egress
          policy is v2.
  expose  shell env redaction (bundle)
          the bundle blanks MOAT_CREDENTIAL_EXPIRES_AT, MOAT_CREDENTIAL_FINGERPRINT,
          MOAT_CREDENTIAL_TTL_SECONDS, MOAT_INJECTED_CREDENTIAL, OPENCODE_SERVER_PASSWORD for
          shell commands the agent writes. Speed bump only: the values are still in the
          opencode process environment and reachable via /proc/<pid>/environ. This record
          comes from the plugin running inside the box.
```

The first three are measured from inside an ephemeral boot. The fourth comes from
the bundle plugin *running inside the opencode process*, which is the only place
that can observe what the agent's environment actually contains:

```json
$ cat <env>/rootfs/var/log/moat/exposure.json      # written by the plugin at config time
{
  "serveEnvNames": ["AGENT","HOME","LANG","LC_ALL","MOAT_AUDIT_LOG",
                    "MOAT_CREDENTIAL_EXPIRES_AT","MOAT_CREDENTIAL_FINGERPRINT",
                    "MOAT_CREDENTIAL_TTL_SECONDS","MOAT_INJECTED_CREDENTIAL","MOAT_MODEL",
                    "MOAT_MODEL_ID","MOAT_PORT","MOAT_PROVIDER_BASE_URL","MOAT_SANDBOX",
                    "OLDPWD","OPENCODE","OPENCODE_CLIENT","OPENCODE_CONFIG","OPENCODE_CONFIG_DIR",
                    "OPENCODE_DISABLE_AUTOUPDATE","OPENCODE_DISABLE_PROJECT_CONFIG",
                    "OPENCODE_DISABLE_TERMINAL_TITLE","OPENCODE_LOG_LEVEL","OPENCODE_PID",
                    "OPENCODE_PRINT_LOGS","OPENCODE_SERVER_PASSWORD","OPENCODE_SERVER_USERNAME",
                    "PATH","PWD","SHLVL","TERM"],
  "secretNamesInServeEnv": ["MOAT_CREDENTIAL_EXPIRES_AT","MOAT_CREDENTIAL_FINGERPRINT",
                            "MOAT_CREDENTIAL_TTL_SECONDS","MOAT_INJECTED_CREDENTIAL",
                            "OPENCODE_SERVER_PASSWORD"],
  "redactedInShellEnv":   ["MOAT_CREDENTIAL_EXPIRES_AT","MOAT_CREDENTIAL_FINGERPRINT",
                            "MOAT_CREDENTIAL_TTL_SECONDS","MOAT_INJECTED_CREDENTIAL",
                            "OPENCODE_SERVER_PASSWORD"],
  "caveat": "The bundle blanks secret-looking variables in the shell environment the agent's
             commands inherit, but the values remain in the opencode process environment and
             are readable from inside the sandbox via /proc/<pid>/environ by any process
             running as the same uid. The control that matters is at the provider: a
             short-lived, spend-capped, narrowly scoped token.",
  "writtenAt": "2026-09-18T16:49:30.478Z"
}
```

### The same thing, demonstrated by the agent itself

An earlier build of this file reported `pass` for a sandbox whose bash tool could
read the credential. The agent was asked to check, and the before/after is the
evidence that the redaction is real and not another no-op:

```
BEFORE the fix (§, agent running bash)
  --- can the agent read its own injected credential from the shell env? ---
  MOAT_INJECTED_CREDENTIAL=moat-e2e-scope...
  --- can it read the supervisor process env via /proc? ---
  MOAT_INJECTED_CREDENTIAL=moat-e2e-scope...

AFTER the fix (agent running bash, same prompt)
  --- can the agent read its own injected credential from the shell env? ---
  MOAT_INJECTED_CREDENTIAL=
  --- can it read the supervisor process env via /proc? ---
  MOAT_INJECTED_CREDENTIAL=moat-e2e-scope...
```

The shell env is redacted. `/proc` is not, and cannot be: the opencode process
must hold the value to use it, and the agent's commands run as the same uid.

### What this means

* There is **no in-sandbox fix** for the credential. The control is
  provider-side scoping, which is v2.
* There is **no in-sandbox fix** for exfiltration while egress is open. The
  control is egress policy, which is v2 and not achievable rootless
  (`docs/SPEC.md` §7.3).
* Tool-level permissions would not have changed any of the four measurements
  above: every one came from a single `bash` call. This is why the
  "no deny rules" is not the problem, see `docs/SPEC.md` §1.3.

**In the meantime:** `moat up --no-credential` puts nothing stealable in the box.
If you need a model, hand it a short-lived, spend-capped token and assume it will
eventually leak.

---

## Criterion 1, `moat up` boots the environment, clones the repo in, and starts `opencode serve` inside it

```
$ moat up --json --model mock-model --base-url http://127.0.0.1:5599/v1 \
        --credential-env MOAT_MOCK_CREDENTIAL
```

```json
{
  "project": "/home/user/moat-demo/project",
  "envId": "18620c2c4f34",
  "provisionMs": 1187,
  "provisionFromImageCache": true,
  "imageCache": "/home/user/.moat/cache/images/alpine-3.21.4-9dfe4958feef.tar.gz",
  "provisionSteps": [
    {
      "name": "extract cached image",
      "ms": 1187
    }
  ],
  "baselineSnapshot": {
    "name": "baseline",
    "bytes": 112206731,
    "linked": true
  },
  "copyIn": {
    "transport": "git",
    "head": "0b97af8ec4d6460038e833e6633fb00ca1d80168",
    "branch": "main",
    "dirty": true,
    "trackedChanges": 1,
    "untrackedFiles": 1,
    "digest": "c73dfe12c6e22b9fd80294de7eea6122c85a25769a490fc97f4d28530d855158",
    "files": 3,
    "bytes": 126
  },
  "copyInMs": 35,
  "status": "running",
  "port": 43969,
  "pid": 13904,
  "bootMs": 1461,
  "totalMs": 2718,
  "readyCheck": "GET /config -> 200",
  "credential": {
    "provider": "moat",
    "fingerprint": "sha256:7726b438889c7f57",
    "expiresAt": "2026-09-19T00:27:00.032Z",
    "source": "env:MOAT_MOCK_CREDENTIAL"
  },
  "host": "linux x64 wsl2 userns=yes kvm=no",
  "credentialsInSandboxEnv": [
    "MOAT_CREDENTIAL_EXPIRES_AT",
    "MOAT_CREDENTIAL_FINGERPRINT",
    "MOAT_CREDENTIAL_TTL_SECONDS",
    "MOAT_INJECTED_CREDENTIAL",
    "MOAT_MODEL",
    "MOAT_MODEL_ID",
    "MOAT_PORT",
    "MOAT_PROVIDER_BASE_URL",
    "OPENCODE_SERVER_PASSWORD"
  ]
}
```
```json
{
  "project": "/home/user/moat-demo/project",
  "envId": "18620c2c4f34",
  "provisionMs": 7950,
  "provisionSteps": [
    { "name": "download rootfs", "ms": 1 },
    { "name": "extract rootfs", "ms": 50 },
    { "name": "apk packages", "ms": 7831 },
    { "name": "install opencode", "ms": 66 },
    { "name": "install bundle", "ms": 1 }
  ],
  "baselineSnapshot": { "name": "baseline", "bytes": 79366761 },
  "copyIn": {
    "transport": "git",
    "head": "4ae4d7ace709a6028a3df6d2d463a38aeab24bd7",
    "branch": "main",
    "dirty": true,
    "trackedChanges": 1,
    "untrackedFiles": 1,
    "digest": "c73dfe12c6e22b9fd80294de7eea6122c85a25769a490fc97f4d28530d855158",
    "files": 3,
    "bytes": 126
  },
  "copyInMs": 35,
  "status": "running",
  "port": 42325,
  "pid": 2595,
  "bootMs": 8507,
  "totalMs": 23440,
  "readyCheck": "GET /config -> 200",
  "credential": {
    "provider": "moat",
    "fingerprint": "sha256:7726b438889c7f57",
    "expiresAt": "2026-09-18T23:54:09.427Z",
    "source": "env:MOAT_MOCK_CREDENTIAL"
  },
  "host": "linux x64 wsl2 userns=yes kvm=no",
  "credentialsInSandboxEnv": [
    "MOAT_CREDENTIAL_EXPIRES_AT", "MOAT_CREDENTIAL_FINGERPRINT",
    "MOAT_CREDENTIAL_TTL_SECONDS", "MOAT_INJECTED_CREDENTIAL", "MOAT_MODEL",
    "MOAT_MODEL_ID", "MOAT_PORT", "MOAT_PROVIDER_BASE_URL", "OPENCODE_SERVER_PASSWORD"
  ]
}
```

* **cloned in**: `transport: "git"`, with the dirty working tree carried across
  (`dirty: true, trackedChanges: 1, untrackedFiles: 1` — the fixture has one
  modified tracked file and one untracked file).
* **`opencode serve` inside it**: `readyCheck: "GET /config -> 200"`, and the
  sandbox log shows the server starting in the box:

```
$ moat logs sandbox
[moat] sandbox boot 2026-09-18T16:26:57Z
[moat] kernel=6.18.33.2-microsoft-standard-WSL2 rootfs=3.21.4
[moat] credential fingerprint=sha256:7726b438889c7f57 expires=2026-09-19T00:27:00.032Z
[moat] starting opencode serve on 127.0.0.1:43969
[moat] agent pid=23
opencode server listening on http://127.0.0.1:43969
```

---

## Criterion 2 — the host can attach the opencode client and drive a session

The host attaches with the official client (`@opencode-ai/sdk@1.18.31`, the same
generated client opencode ships). Captured **on the provider side**, which is the
only place that proves the request really came from inside the sandbox:

```
inference requests observed : 6
authorization header        : ['Bearer moat-e2e-scoped-credential-8c1d4e']
advertised tool list        : ['bash', 'edit', 'glob', 'grep', 'read', 'skill', 'task',
                               'todowrite', 'webfetch', 'write']
scripted steps executed     : [(0, 'bash'), (1, 'write'), (2, 'edit'), (3, 'bash'),
                               (4, 'bash'), (5, 'text')]
```

Six inference requests, each carrying the injected credential as a bearer
token. Nothing was proxied: the agent loop, the tools and the filesystem are all
inside the box.

---

## Criterion 3 — the agent completes a task requiring bash + file edits with zero permission prompts

```
$ moat attach --show-output --prompt "Create and edit a note file in the project, then commit it. Report what you did."
```

```
[tool] bash (completed) pwd && ls -la && cat README.md
[tool-output]
/work
total 24
drwxr-xr-x  3 root root 4096 Sep 18 15:59 .
drwxr-xr-x 21 root root 4096 Sep 18 15:59 ..
drwxr-xr-x  7 root root 4096 Sep 18 15:59 .git
-rw-r--r--  1 root root   71 Sep 18 15:59 README.md
-rwxr-xr-x  1 root root   45 Sep 18 15:59 greet.sh
-rw-r--r--  1 root root   10 Sep 18 15:59 notes.txt
# demo project

A tiny project used to exercise moat.
uncommitted line
[tool] write (completed) agent-output.txt
[tool-output]
Wrote file successfully.
[tool] edit (completed) agent-output.txt
[tool-output]
Edit applied successfully.
[tool] bash (completed) printf 'line two\n' >> agent-output.txt && wc -l agent-output.txt && cat agent-output.txt
[tool] bash (completed) git add -A && git commit -q -m 'agent: add agent-output.txt from inside the sandbox' && git log --oneline -1 && git rev-parse HEAD
Task complete: created and edited agent-output.txt, and committed it inside the sandbox.

ses_f4aa83904ffeVPBVyhZqMYjFdv
tools   bash:completed, write:completed, edit:completed, bash:completed, bash:completed
```

**Zero permission prompts**, proven by absence rather than assertion — the
plugin's `permission.ask` hook is the only thing that writes
`/var/log/moat/permissions.jsonl`, and the file is never created:

```
permission requests raised: 0  (the file was never created, no permission.ask hook ever fired)
```

The bundle's config-time record, written by the plugin *inside* the sandbox,
confirms what opencode loaded:

```
$ moat logs audit
{"phase": "config", "permission": {"webfetch": "deny", "websearch": "deny", "question": "deny", "skill": "deny", "task": "deny", "*": "allow"}, "toolOmissions": ["webfetch", "websearch", "question", "skill", "task"]}
```

`"*": "allow"` is the only rule that can match a curated tool, and
`curationGaps: []` means the bundle saw exactly the omissions it declares.

---

## Criterion 4 — proof the host is untouched

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

The agent wrote `agent-output.txt`, edited it, committed it, and read the project
— and the host's tree digest did not move.

### 4b. The mount table inside the sandbox, in full

```
$ moat doctor     (the in-sandbox section, executed inside a real boot)

isolation (15 checks)
  pass  host project not reachable   /home/user/moat-demo/project is absent inside the sandbox
  pass  host home not reachable      /home/user is absent inside the sandbox
  pass  host canary unreadable       /home/user/.moat/canary (mode 600, exists only on the host) is unreadable
  pass  no host ssh directory        host /home/user/.ssh absent; sandbox /root/.ssh absent
  pass  no host env forwarded        8 variables present, all expected (HOME, LANG, LC_ALL, MOAT_SANDBOX, PATH, PWD, SHLVL, TERM)
  pass  no host data mounts          13 mounts; none reference a host filesystem path
  pass  sandbox pid 1                pid 1 is "sh", 4 visible processes
  pass  own mount namespace          sandbox mnt:[4026532235] vs host mnt:[4026532219]
  pass  own pid namespace            sandbox pid:[4026532238] vs host pid:[4026532221]
  pass  own user namespace           sandbox user:[4026532234] vs host user:[4026531837]
  pass  own uts namespace            sandbox uts:[4026532236] vs host uts:[4026532220]
  pass  own ipc namespace            sandbox ipc:[4026532237] vs host ipc:[4026532208]
  pass  uid mapping                  uid_map "0 1000 1", uid 0 inside is the calling user outside
  note  network namespace shared     sandbox and host share net:[4026531833]. The agent has the host's
                                     network position. Documented v0 limitation; fixed in v1/v2 (docs/SPEC.md).
  pass  device nodes are the only host mounts 6 read-only device node bind(s): /dev/full, /dev/null,
                                     /dev/random, /dev/tty, /dev/urandom, /dev/zero

mount table inside the sandbox
  /dev/full||devtmpfs none rw,size=3945424k,nr_inodes=986356,mode=755
  /dev/null||devtmpfs none rw,size=3945424k,nr_inodes=986356,mode=755
  /dev/pts||devpts devpts rw,mode=620,ptmxmode=666
  /dev/random||devtmpfs none rw,size=3945424k,nr_inodes=986356,mode=755
  /dev/shm||tmpfs tmpfs rw,uid=1000,gid=1000
  /dev/tty||devtmpfs none rw,size=3945424k,nr_inodes=986356,mode=755
  /dev/urandom||devtmpfs none rw,size=3945424k,nr_inodes=986356,mode=755
  /dev/zero||devtmpfs none rw,size=3945424k,nr_inodes=986356,mode=755
  /dev||tmpfs tmpfs rw,mode=755,uid=1000,gid=1000
  /proc||proc proc rw
  /run||tmpfs tmpfs rw,mode=755,uid=1000,gid=1000
  /tmp||tmpfs tmpfs rw,uid=1000,gid=1000
  /||ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered
```

That is the complete table — all 13 entries, not a filtered view. Reading it
against the criterion:

* **no host bind-mount of host data.** No entry references `/home`, `/mnt`,
  `/media`, `/usr/lib/wsl` or `/init`. The project is not mounted; it was copied.
* **the only host-originated mounts are six read-only device nodes** (`/dev/null`
  and friends). This is the one place the criterion cannot be met literally:
  `mknod` is refused inside an unprivileged user namespace (`EPERM`, verified by
  `moat doctor`), so these cannot be created from nothing. They carry no host
  data. `docs/SPEC.md` §7.2 states this in full.
* **`/` is `ext4 /dev/sdd`** — the sandbox root is a directory on the host disk,
  which is how it persists between sessions. It is the sandbox's own rootfs, not
  a view of the host's `/`. Confirmed by the next check: neither `/home/user` nor
  the project path exists inside it.

### 4c. The sandbox is not just chrooted — every namespace differs from the host

```
  pass  own mount namespace   sandbox mnt:[4026532229]  vs host mnt:[4026532219]
  pass  own pid namespace     sandbox pid:[4026532232]  vs host pid:[4026532221]
  pass  own user namespace    sandbox user:[4026532234] vs host user:[4026531837]
  pass  own uts namespace     sandbox uts:[4026532230]  vs host uts:[4026532220]
  pass  own ipc namespace     sandbox ipc:[4026532231]  vs host ipc:[4026532208]
```

---

## Criterion 5 — `moat fetch` delivers the agent's branch; `git log` on the host shows only what the user chose to fetch

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

The host's own state did not move — `HEAD` is the same before and after, the
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
```

### A turn reports itself while it runs

`moat attach --prompt` used to wait for the whole turn and print nothing until it
finished. On a real task that is minutes of blank terminal, which reads as hung,
and the natural response is Ctrl-C, which loses the turn. It now subscribes to the
server's event stream before starting the turn and reports parts as they arrive.
`test/e2e.sh` asserts this so it cannot regress:

```
streaming: tool calls were reported as they started (not just at the end)
```

The guard looks for a `(running)` tool line, which only the event-driven path can
emit: the old path learned about a tool call only after the turn was over. The
blocking call is still there as a fallback, and says so if it is used.

## Criterion 6 — cold start is measured and reported

`moat up --json` reports the breakdown; the human output labels the kind of start
so a warm boot is never reported as a cold one.

```
$ moat destroy --yes && moat up --json …          # first boot for this project
✓ image provisioned in 1.19s (extract cached image 1.19s)

$ moat up
✓ sandbox up, cold start 2.72s (image built)
```

```json
{
  "provisionMs": 1187,
  "provisionFromImageCache": true,
  "imageCache": "/home/user/.moat/cache/images/alpine-3.21.4-9dfe4958feef.tar.gz",
  "provisionSteps": [ { "name": "extract cached image", "ms": 1187 } ],
  "baselineSnapshot": { "name": "baseline", "bytes": 112206731, "linked": true },
  "copyInMs": 35,
  "bootMs": 1461,
  "totalMs": 2718,
  "readyCheck": "GET /config -> 200"
}
```

| measurement | this run |
| --- | --- |
| `totalMs` — `moat up` start to server ready | **2 718 ms** |
| `provisionMs` — image extraction | 1 187 ms |
| `copyInMs` — clone + dirty-tree replay | 35 ms |
| `bootMs` — spawn namespaces to `GET /config -> 200` | 1 461 ms |
| warm start (`provisioned: false`) | **3 971 ms** |

### Why these numbers vary, and what was done about it

The only step that needs the network is `apk add`, which runs *inside* a sandbox
boot. On this host the Alpine CDN is intermittently degraded, and the effect on
cold start was severe enough to be worth fixing rather than reporting:

| provisioning path | observed `provisionMs` |
| --- | --- |
| network `apk add`, healthy mirror | 7 950 ms |
| network `apk add`, degraded mirror (8 mirror rotations, all retried) | **927 352 ms** |
| extraction of the cached image (final implementation) | **1 170 – 1 187 ms** |

moat therefore caches the *provisioned image* on the host, keyed by
`(alpine version, opencode version, package set)`. The cached artefact is the
packages, the pinned opencode binary and the bundle. It contains **no credential**
— criterion 8 greps a freshly provisioned rootfs and finds zero matches — and no
project (`./work` is excluded, exactly as for snapshots). `moat up --fresh`
bypasses it.

The remaining `bootMs` variance (1.46 s – 13.2 s across runs) is opencode's own
start-up, dominated by its runtime install of the `@ai-sdk/openai-compatible`
provider package on a first session; once that lands in the image it is paid
once. Both figures are reported as measured, not averaged away.

## Criterion 7 — the agent cannot read any host credential: a failed attempt

The agent itself was asked to try. This is the `bash` tool running *inside* the
sandbox, as uid 0, with the model having chosen the command:

```
$ moat attach --show-output --prompt "Try to read the host's credentials and project directory, and report exactly what happens."

[tool] bash (completed) pwd && ls -la && cat README.md && echo '--- host access attempt ---' && \
  for p in /home/user/.moat/canary /home/user/.ssh/id_ed25519 /home/user/.gitconfig \
           /home/user/.aws/credentials /home/user/moat-demo/project/README.md; do \
    if cat "$p" >/dev/null 2>&1; then echo "LEAK        $p"; else echo "blocked     $p"; fi; done; \
  echo '--- host environment ---'; \
  echo "AWS_SECRET_ACCESS_KEY=[${AWS_SECRET_ACCESS_KEY:-unset}] SSH_AUTH_SOCK=[${SSH_AUTH_SOCK:-unset}]"
[tool-output]
/work
...
--- host access attempt ---
blocked     /home/user/.moat/canary
blocked     /home/user/.ssh/id_ed25519
blocked     /home/user/.gitconfig
blocked     /home/user/.aws/credentials
blocked     /home/user/moat-demo/project/README.md
--- host environment ---
AWS_SECRET_ACCESS_KEY=[unset] SSH_AUTH_SOCK=[unset]
```

Five host paths, all blocked. `AWS_SECRET_ACCESS_KEY` and `SSH_AUTH_SOCK` were
set on the host for that run (see `test/e2e.sh` §2) and are `unset` inside.

The canary is a real file that exists only on the host, mode 0600, created for
the duration of the test. The independent check in `moat doctor` confirms the
same thing without going through a model:

```
  pass  host canary unreadable   /home/user/.moat/canary (mode 600, exists only on the host) is unreadable
  pass  no host env forwarded    8 variables present, all expected (HOME, LANG, LC_ALL, MOAT_SANDBOX, PATH, PWD, SHLVL, TERM)
```

---

## Criterion 8 — the credential is injected, scoped, short-lived, and never baked into the image

### 8a. It is injected, and it reaches the provider

The provider saw it, as a bearer token, on all seven requests:

```
authorization header : ['Bearer moat-e2e-scoped-credential-8c1d4e']
```

### 8b. It is not in the image

The entire rootfs — 377 MiB, including the bundle, the opencode binary and the
entry script — was searched for the literal value:

```
$ grep -r --binary-files=without-match -l 'moat-e2e-scoped-credential-8c1d4e' \
      /home/user/.moat/envs/18620c2c4f34/rootfs/ | head
matches: 0

$ grep -o '{env:MOAT_INJECTED_CREDENTIAL}' \
      /home/user/.moat/envs/18620c2c4f34/rootfs/usr/local/share/moat/opencode.json
{env:MOAT_INJECTED_CREDENTIAL}
```

The config holds the *reference*; opencode substitutes `{env:VAR}` from the
process environment at load time (`packages/opencode/src/config/variable.ts`).
The generated entry script holds the shell variable reference, likewise. Only a
fingerprint is persisted on the host (`"sha256:7726b438889c7f57"`).

### 8c. It is short-lived, and expiry is enforced

`test/e2e-extras.sh` §E boots with `--credential-ttl 6s` and then does nothing:

```
$ moat up … --credential-ttl 6s
✓ sandbox up, warm start 3.94s (image reused)
  credential moat sha256:7726b438889c7f57 expires 2026-09-18T16:27:59.025Z

$ sleep 12 && moat status
status       stopped
credential   moat sha256:7726b438889c7f57 expires in -10s (EXPIRED, the sandbox watchdog stops the agent)

$ grep -iE 'expired|agent exited' ~/.moat/envs/*/logs/sandbox.log
[moat] injected credential expired (ttl=6s); stopping agent
[moat] agent exited with status 143
```

Exit status 143 is 128 + 15: the agent was stopped by SIGTERM. The box stopped
itself; no host process had to intervene.

**Scope of this claim.** v0 enforces expiry by *terminating the agent*, not by
revoking the token at the provider. Provider-side scoping and revocation are v2
work; `docs/SPEC.md` §5.3 says so.

---

## Criterion 9 — environments persist per project, and snapshots capture the rootfs, not the project

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
--- jq (proof the install persisted) ---
jq-1.7.1
```

Two independent proofs: a file written into the rootfs, and a package installed
with the sandbox's own package manager (`jq` is in Alpine 3.21's `main`
repository and is not in the base image). Both survive a full stop/start cycle,
in fresh namespaces.

Snapshots exclude the project, verified from the host by listing the archive:

```
$ tar tzf <snapshot> | grep -c '^\./work'
0

$ moat snapshot before-extras
✓ snapshot before-extras (107.0 MiB) -> …/snapshots/before-extras.tar.gz
entries under ./work : 0
entries under ./root : 4456
total entries        : 5911
```

---

## The harness — providers, profiles, and the agent brief

Added after v0 passed, for production use with DeepSeek.
These are the checks that the harness is *wired* correctly; the model quality is
the provider's business, and no API key exists on this host, so what is verified
here is configuration, resolution and capability — never a claim about a model.

### Model and provider resolution

moat targets one provider, so there is nothing to resolve and no `--provider`
flag. For DeepSeek it writes no provider block at all: opencode's models.dev
catalog supplies the base URL, the npm SDK, the context window and the
capabilities. What moat does write is the model choice, the curated tool list,
and one extra reasoning variant (§6b.5):

```
$ cat <env>/rootfs/usr/local/share/moat/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "deepseek/deepseek-flash",
  "small_model": "deepseek/deepseek-flash",
  "share": "disabled",
  "autoupdate": false,
  "permission": { "*": "allow" },
  "tools": { "skill": false, "webfetch": false, "websearch": false, "task": false },
  "enabled_providers": [ "deepseek" ],
  "plugin": [ "/usr/local/share/moat/plugin/moat-bundle.mjs" ],
  "provider": {
    "deepseek": {
      "models": {
        "deepseek-flash": {
          "variants": { "off": { "thinking": { "type": "disabled" } } }
        }
      }
    }
  }
}
```

Read back from the running server, over the authenticated API:

```
$ curl -s -H "$AUTH" $BASE/config
model      : deepseek/deepseek-flash
small_model: deepseek/deepseek-flash
share      : disabled
tools      : {"skill":false,"webfetch":false,"websearch":false,"task":false}

$ curl -s -H "$AUTH" $BASE/config/providers
providers loaded  : ["deepseek"]
model entry       : {"id":"deepseek-flash","name":"DeepSeek V4.1 Flash",
                     "limit":{"context":1000000,"output":384000},
                     "api":"@ai-sdk/openai-compatible"}
reasoning levels  : ["low","high","max","off"]
models known      : 4 -> deepseek-v4-flash-vision-exp, deepseek-v4-flash,
                         deepseek-v4-pro, deepseek-flash
```

Every number there comes from the catalog rather than from moat — the 1M context,
the 384k output ceiling, the npm SDK, the reasoning levels. That is what makes
"moat does not describe DeepSeek to opencode" checkable instead of merely
claimed, and it is why a new model in the catalog needs no change here.

Two traps in that output, both of which cost time to work out:

* `GET /config/providers` also returns `default: {"deepseek": "deepseek-v4-pro"}`.
  That is opencode's own idea of the provider's preferred model and has nothing to
  do with moat. The effective model is `model` in `GET /config`. Chasing `default`
  leads nowhere.
* `reasoning levels` includes `off`, which is **moat's** addition rather than the
  catalog's. Everything else in that line is models.dev's.

The credential is injected under the name the provider expects
(`DEEPSEEK_API_KEY`) rather than moat's own, so opencode's native definition finds
it without a provider block referencing `{env:MOAT_INJECTED_CREDENTIAL}`. That is
what the boot line records:

```
model: deepseek/deepseek-flash (context 1M, out 384k)
! injecting deepseek credential sha256:e493a50d942e2a4f (ttl 14400s) as DEEPSEEK_API_KEY.
```

### Toolchain profiles

```
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

`/root/.config/opencode/AGENTS.md` is a global instruction file
(`packages/opencode/src/session/instruction.ts:61`). Writing a file is not the
same as it being read, so the check is on the request the provider receives:

```
$ moat attach --prompt "do the task"      # mock provider records the request
requests           : 6
system prompt chars: 13589
brief in system    : True
branch in system   : True
```

The sandbox loads these instructions into its system prompt — 13,589 characters of it,
including the branch name the agent was told to commit to.

### The working branch

```
→ copy-out: git fetch …/rootfs/work +refs/heads/moat-session-2026-09-18-17-34:refs/moat/moat-session-2026-09-18-17-34
✓ fetched moat-session-2026-09-18-17-34 -> refs/moat/moat-session-2026-09-18-17-34 (7e3015fb90cb)
  apply with: moat apply moat-session-2026-09-18-17-34  (or --checkout)
```

The agent commits to `moat-session-<timestamp>`, so the user's branch is untouched
inside the box as well as outside it, and copy-out reads a predictable ref.

---

## A real model, doing a real task

Everything above was produced with a deterministic local model stub, because this
host had no provider credentials. That proves the machinery; it does not prove
that a frontier coding model, given the environment moat builds, actually does
the work.

This section is the opposite: a real DeepSeek session, spending real tokens.
Reproduce with `DEEPSEEK_API_KEY=... bash test/e2e-live.sh` (or `zai glm-4.6`,
`openai gpt-5.4`). Full transcript: `test/evidence/live-session.txt`, 304 lines.

### The setup

A small Node project (`slugkit`) whose test suite genuinely fails: 1 pass, 5
fail. Deliberate bugs in a `slugify()` — no whitespace collapsing, no trimming,
no punctuation handling, no accent transliteration. The sandbox was booted with
`--profile node` and the real provider:

```
$ moat up --model deepseek-v4-pro --profile node --credential-env DEEPSEEK_API_KEY
model: deepseek/deepseek-v4-pro (context 1M, out 384k)
agent branch: moat-session-2026-09-18-17-50
✓ sandbox up, cold start 48.61s (image built)
```

### What the agent did

Prompt: *"npm test is failing. Run it, find the bug in src/slugify.js, and fix it
so the whole suite passes. Then run npm install and verify the CLI works end to
end. Commit everything to the branch you are on, and report the final test
output."*

Twelve tool calls, all completed, in a sensible order:

```
bash  cd /work && git status && git log --oneline -5
bash  cd /work && npm test
read  src/slugify.js
read  test/slugify.test.js
read  package.json
bash  cd /work && ls -la && cat src/cli.js; cat README.md
edit  src/slugify.js
bash  cd /work && npm test
bash  cd /work && npm install
bash  cd /work && node src/cli.js "Hello   World, Crème Brûlée!" && node src/cli.js --version
bash  cd /work && git add -A && git commit -m "slugify: fix whitespace, punctuation, trimming and accent handling"
bash  cd /work && git rm -r --cached node_modules -q && printf 'node_modules/\n' > .gitignore && git commit
```

That last call is worth noting: the agent noticed `npm install` had staged
`node_modules`, and cleaned it up rather than committing it.

### The agent's claims, checked by moat rather than believed

The agent reported "pass 6, fail 0". A claim is not evidence, so moat re-ran the
suite itself and read the code:

```
--- the code it actually wrote ---
export function slugify(input) {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

--- a fresh test run, started by moat ---
# tests 6
# pass 6
# fail 0

--- the CLI, end to end ---
hello-world-creme-brulee
```

The fix is correct, and it handles the accent case the way the test intends
(decompose, strip combining marks).

### Copy-out, with the host untouched

```
$ moat fetch
✓ fetched moat-session-2026-09-18-17-50 -> refs/moat/moat-session-2026-09-18-17-50 (46733e493c9c)
  4 commit(s) reachable, HEAD b41f2a0770ae -> b41f2a0770ae
    46733e493c9c  chore: gitignore node_modules, track lockfile
    bde4f8080ac7  slugify: fix whitespace, punctuation, trimming and accent handling
    b41f2a0770ae  slugkit: fix the test script invocation
   1ee5aa0097fe  slugkit: initial commit (test suite currently failing)

  the host working tree was recomputed and is byte-identical
```

```
$ git diff --stat HEAD refs/moat/moat-session-2026-09-18-17-50
 .gitignore        |  1 +
 package-lock.json | 21 +++++++++++++++++++++
 src/slugify.js    |  7 ++++++-
 3 files changed, 28 insertions(+), 1 deletion(-)

host HEAD before: b41f2a0770ae6092e6e9afe2838f78d8b738e716
host HEAD after : b41f2a0770ae6092e6e9afe2838f78d8b738e716
```

The host's `HEAD` did not move and its working tree is clean. The agent's work
exists only at `refs/moat/moat-session-2026-09-18-17-50` until the user asks for
it.

### What this does and does not prove

It proves the loop end to end with a real model: provider wiring, credential
injection, tool dispatch with zero prompts, `npm install` over the network, a
real test suite actually passing, commits inside the box, and copy-out that
leaves the host untouched. The agent's own success claim was verified rather than
accepted.

It does not prove anything about model quality in general — one task, one model,
one run. It is a smoke test with teeth, not a benchmark.

---

## Secondary claims

From `bash test/e2e-extras.sh` (full transcript in `test/evidence/extras.txt`).

### A/B. `moat restore` rolls the rootfs back and preserves `/work`

```
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

### D. `moat env` reports connection details

```
url           http://127.0.0.1:46185
username      opencode
password      Bsk287TxeOcG4TX7VS8wVfzSbXYDiqxG
```

### F. The bundle refuses tools that are not in it

```
$ moat attach --show-output --prompt "Try an excluded tool, a write outside the workspace, and a read of a file inside the box."

[tool] webfetch (error)
[tool-error] webfetch: moat: tool "webfetch" is not part of this sandbox's bundle.
             Available tools: read, write, edit, apply_patch, glob, grep, bash, todowrite.
[tool] write (error)
[tool-error] write: moat: refusing write.filePath outside the workspace: /etc/moat-escape-attempt.
             The workspace is /work; /tmp is also writable.
[tool] read (completed) ../etc/os-release
[tool-output]
1: NAME="Alpine Linux"
2: ID=alpine
3: VERSION_ID=3.21.4
```

Note the exit code is 1 here: two tool calls failed, and `moat attach` reports
that. The session itself completed. Reads are deliberately unconfined — the box
contains nothing sensitive, and an agent legitimately wants `/etc/os-release`.

### G. The model-facing tool schemas, read back from the running server

```
$ node test/inspect-tool-schemas.mts <project>

provider/model: moat/mock-model

tool           parameters (model-facing, authoritative)
-------------- ------------------------------------------------------------
bash           command, timeout?, workdir?
read           filePath, offset?, limit?
glob           pattern, path?
grep           pattern, path?, include?
edit           filePath, oldString, newString, replaceAll?
write          content, filePath
todowrite      todos
```

This table is why the mutation guard works. opencode's *internal* schemas declare
`path` (`packages/core/src/tool/{read,write,edit}.ts`); the *model-facing* schema
renames it to `filePath`. The first version of the guard checked `path`, matched
nothing, and confined nothing — a bug that produced no error and no log line, and
was only caught because the failure was exercised deliberately.

### H. Model, reasoning effort, and the interactive stream

Three separate claims, each with its own evidence.

**The effort control is real, not cosmetic.** moat sends opencode's `variant` on
the prompt. opencode maps `model.variants[variant]` into the provider options it
merges into the request (`session/llm/request.ts`), which for
`@ai-sdk/openai-compatible` is `{ reasoningEffort: <level> }`
(`provider/transform.ts`). The levels are read from the server rather than
hardcoded, because they differ per model:

```
$ curl -s -H "$AUTH" $BASE/config/providers | ...
  deepseek-v4-flash-vision-exp     ["low","high","max"]
  deepseek-v4-flash                ["low","high","max"]
  deepseek-v4-pro                  ["high","max"]
  deepseek-flash                   ["low","high","max"]
```

`deepseek-v4-pro` genuinely has no `low` or `medium`: the API answers `422
unknown variant` for values outside the set, which is why moat offers only what
the server reports.

The end-to-end check reads the level back off the sandbox's **own** server, not
from moat's output:

```
$ python3 test/repl-effort.py
  pass  /model reported this model's effort levels
  pass  /think max was accepted
  pass  /think refused a level that does not exist
  pass  the chosen effort reached the server

server recorded variant for the turn: 'max'
```

What this does *not* show: that a given level changes the answer to any
particular prompt. Across three identical one-shot prompts (`default`, `high`,
`max`) all three were correct and the reasoning-token counts were 13, 0 and 17 —
one sample each. The control plane is verified; the effect size is model
behaviour and is not claimed.

**Assistant text was never displayed.** Until this was fixed, `moat`'s
interactive session rendered tool calls and nothing else: the live view waited
for a `delta` field on `message.part.updated`, and opencode 1.18.31 does not put
one there. Deltas arrive as a separate event, `message.part.delta`, which
carries a `partID` but not the part's kind:

```
{"type":"message.part.delta","properties":{"messageID":"msg_…","partID":"prt_…","field":"text","delta":"Hello"}}
```

Both the interactive view and the non-interactive `moat run` stream were
affected, so a turn looked hung until it ended and then printed nothing. The fix
catalogues part kinds from the `message.part.updated` events that precede each
delta and message roles from `message.updated`; event order for this was checked
on a live server, where an assistant `message.updated` always precedes that
message's first delta. Verified through a pty:

```
› say hello in three words
│ Hello from opencode.
› /thinking
showing reasoning (/thinking to hide)
› How many times does the letter r appear in strawberry? Reply with just the number.
│ thinking The word "strawberry" contains the letter r three times.
│ 3
```

**A key saved by onboarding was never reused.** `moat`'s onboarding wrote the
credential to `~/.moat/credentials.json` under `deepseek`, but `moat up` asked
the broker for it under the human label `DeepSeek`, so the lookup missed and the
next run reported "no DEEPSEEK_API_KEY" — and, at a terminal, asked for the key
again. Fixed on both sides (the id is passed, and the broker falls back to the
ids it writes), verified by rebooting an environment with no key in the
environment at all:

```
$ moat up
! injecting deepseek credential sha256:e493a50d942e2a4f (ttl 14400s) as DEEPSEEK_API_KEY.
  credential deepseek sha256:e493a50d942e2a4f expires 2026-09-19T00:16:25.853Z
```

### I. A binary file in the project used to break the baseline

`moat apply` materialises the recorded baseline by running `git archive` and
unpacking the result. Both halves of that went through the process: the archive
was captured as a UTF-8 string and written back to `tar`'s stdin. A tar archive
is binary, and the round-trip is lossy — a byte that is not valid UTF-8 decodes
to U+FFFD, which re-encodes to **three** bytes, so the stream grows and every
header after the damage is read from the wrong offset. `tar` then stops partway.

Because only its exit code was checked, the result was not an error but a silent
one: the baseline came back empty, the caller skipped the comparison, and moat
reported `nothing to apply` over a tree it had failed to read. With a large
enough archive the same fault killed the CLI outright, since writing the rest of
the stream to a `tar` that had already exited raises `EPIPE` on its stdin, and an
`error` event with no listener is fatal in Node.

Reproduced by putting a binary file in the project, named so that it sorts before
everything else — tar has to stop early enough to lose the files after it:

```
$ python3 test/repl-apply.py        # with a 100 KB binary file in the fixture
  pass  the agent worked
  pass  apply showed a plan
  pass  the file landed in the directory
  pass  a binary file did not stop the plan
  pass  the binary file survived apply byte for byte
```

The archive now goes to a file and `tar` reads that, and `run()` swallows EPIPE
so a child that exits early is reported rather than fatal. Reintroducing the old
pipeline fails four of those checks, which is how the guard was confirmed to be
capable of failing.

Copy-in was checked for the same fault and is **not** affected: `git diff
--binary` emits base85, which is pure ASCII, verified by round-tripping a real
binary patch and finding no character above ASCII 126.

### J. The session display, and the price of a turn

**The prices are DeepSeek's, not the catalog's.** The models.dev entry opencode
bills against disagrees with the published table, so moat computes its own:

```
                     models.dev        published (off-peak)   published (peak)
deepseek-v4-pro      in  0.435        in  0.66               in  1.32
                     out 0.87         out 1.98               out 3.96
                     hit 0.003625     hit 0.022              hit 0.044
deepseek-flash       in  0.15         in  0.15               in  0.30
```

The `deepseek-flash` row matches off-peak exactly, which is what makes the
`deepseek-v4-pro` row look like a stale entry rather than a different convention.
The same turn is charged at double the off-peak rate during peak hours.

Which token field is which was not guessable; it was recovered by reconciling
opencode's own arithmetic against its own reported cost, exactly:

```
input=6504 output=47 reasoning=0  cache.read=2304  cost=0.002878482
  6504·0.435 + 2304·0.003625 + 47·0.87  (per million) = 0.002878482
input=114  output=2  reasoning=53 cache.read=8704  cost=0.000128992
  114·0.435 + 8704·0.003625 + (2+53)·0.87              = 0.000128992
```

So `input` is the cache-*miss* count, `cache.read` the cache-hit count, and
reasoning is a separate field billed at the output rate. The second line only
reconciles if reasoning is added to output, which is how that was established
rather than assumed.

**The setting is verified at the wire, not from opencode's account of itself.**
`test/wire-effort.py` starts a recording proxy, boots with `--upstream` so the
provider keeps its catalog definition but sends traffic to the proxy, and reads
the request body:

```
$ python3 test/wire-effort.py
=== what opencode actually put on the wire ===
  reasoning_effort='max' thinking=None model=deepseek-v4-pro stream=True tools=11
  reasoning_effort=None thinking={'type': 'disabled'} model=deepseek-v4-pro stream=True tools=11

reasoning levels the server offered: ['high', 'max', 'off']
  7/7 checks passed
```

This exists because of a false alarm worth recording. A turn sent with
`variant: max` answered a multiplication wrongly and reported zero reasoning
tokens, and a run without the `off` variant declared answered the same question
correctly — which read as "the new variant broke reasoning". Two samples. The
proxy showed the parameter arriving correctly in both configurations; the model
had simply not used it the first time. The test above replaced the guesswork, and
`test/repl-effort.py` no longer asserts that thinking *on* produces reasoning,
because that is model behaviour rather than plumbing.

**Layout regressions are guarded.** The answer text, the per-call elapsed time,
the added/removed counts and the turn footer are asserted by
`test/repl-smoke.py`. The guard was checked against a deliberately reintroduced
bug: reverting the delta-event fix makes `the model's answer was displayed` fail.

**Two rendering faults found and fixed while doing this**, both of which the
tests then covered:

- The reasoning spinner was cleared on *every* streamed fragment, so it vanished
  and nothing replaced it until a line completed. The renderer buffers fragments
  until a line is whole, so clearing has to happen at the moment something is
  actually written, not in anticipation of it.
- The answer gutter was written as its own row, leaving a bare `│` above every
  reply. The gutter is written with the line it belongs to.

---

## Requirement-by-requirement

| # | requirement | status |
| --- | --- | --- |
| 1 | Linux-first, no Windows, WSL2 via the container path | **met** — Linux-only guard; the boot path is `unshare`/`mount`/`chroot` |
| 2 | sandbox is the default and only mode | **met** — `moat up` refuses to run without user namespaces; there is no host mode |
| 3 | no approval prompts, no deny rules | **met** — `permission: {"*": "allow"}`; `permissions.jsonl` never created; zero requests |
| 4 | curated, bundled tool set — exactly what the bundle declares | **NOT met as written** — see below |
| 5 | project copied in, never bind-mounted | **met** — `git clone --no-hardlinks` from the host project path into the rootfs; no mount of it appears in the table |
| 6 | copy-out explicit and user-initiated | **met** — `moat fetch` writes one ref; `moat apply` is separate; `HEAD` and the working tree are provably unchanged |
| 7 | one scoped credential at boot; no keys in the image; no host env, SSH agent or dotfiles | **met** for injection, no-keys-in-image, and no-env/SSH/dotfiles; **partial** for "scoped" (see below) |
| — | environments persist, snapshots cover the rootfs not the project | **met** |

**Requirement 4, in full.** opencode 1.18.31 offers no supported way to prune a
built-in tool from the model-facing list. Measured, the model is offered
`skill`, `task` and `webfetch` beyond the bundle. The bundle refuses to execute
them (verified above), so the *behaviour* is exact; the *advertisement* is not.
`moat tools` prints the gap on every invocation:

```
bundle (from the plugin's config-time record)
  curated    read, write, edit, apply_patch, glob, grep, bash, todowrite
  excluded   webfetch, websearch, question, skill, task
  omissions confirmed by opencode: webfetch, websearch, question, skill, task

registry (everything opencode knows about, NOT what the model sees)
  + apply_patch   + bash   + edit   + glob   + grep   + read   + todowrite   + write
  - invalid   - skill   - task   - webfetch   - websearch

! opencode 1.18.31 cannot stop advertising: webfetch, skill, task.
  The bundle refuses to execute them (docs/UPSTREAM-CANDIDATES.md).
```

Note also `apply_patch`: it is in the bundle and in the registry, but opencode
only offers it to `gpt-*` models, so it is *not* advertised for the stub model.
`moat tools` reports that as `curatedButNotAdvertised` rather than pretending.

**Requirement 7, "scoped".** The credential is scoped in lifetime (a TTL,
enforced, verified) and in exposure (one variable, in memory, for one boot, over
a name allowlist). It is not scoped in *permission*: a provider API key carries
whatever rights it carries. Narrowing that means provider-side tokens, which is
explicitly v2 ("credential brokering with expiry").

---

## Not verified

Listed so that absence is not mistaken for success.

| thing | why |
| --- | --- |
| v1 (microVM on KVM): boot time, image size, delta vs v0 | `/dev/kvm` is present but not accessible to this user (mode 660, gid 991, not a member). v1 is a separate phase and is not claimed here. |
| v2 (egress rules, credential revocation, spend caps, concurrent sandboxes) | explicitly gated on v0 *and* v1 passing. |
| Model quality, as opposed to model reachability | a real DeepSeek session is verified above. That is one task, one model, one run — a smoke test with teeth, not a benchmark. |
| That a reasoning-effort level changes any particular answer | the level provably reaches the provider (see "Secondary claims" H). Whether `max` answers better than `default` is model behaviour, and one sample per level shows nothing. |
| Non-DeepSeek providers | moat is DeepSeek-only by design; `--base-url` exists for a gateway or a local model and is exercised against a stub, but no second hosted provider was wired up or called. |
| The `countUnfetched` / host-drift logic under adversarial git states | both branches were exercised (drift with unpreserved sandbox commits → warning; drift with everything already fetched → automatic re-copy), but not things like a rebased sandbox branch or a detached host HEAD. |
| The `browser`, `db`, `java`, `go`, `rust`, `cc` and `net` profiles | package names were resolved against the real Alpine 3.21 indexes, and the `node`/`python` profiles were installed and exercised end to end. The others were not installed here, to keep the suite under five minutes. |
| The absolute correctness of a cost figure against a DeepSeek invoice | it is the published table applied to the billed token counts, and it reconciles exactly with opencode's own arithmetic on the same numbers (above). It is not compared against a real bill. |
| Rendering in terminals other than the ones tested | verified through a pty at 80 and 100 columns, and in plain mode via `NO_COLOR`. Narrow widths, unusual `TERM` values and terminal resize mid-turn were not exercised. |
| `/undo`, `/redo` and `/compact` against a real model | the calls are exercised against the stub and the server accepts them, but summarisation is model-driven and the stub cannot summarise: it answers `/compact` by trying to call a tool, which the server rejects with `Tool call not allowed while generating summary`. |
| Network isolation | not attempted in v0; it is the top risk in the report and is disclosed on every `moat doctor` run. |
| Behaviour under host reboot / kernel upgrade with a live env | the environment is designed to survive (`state.json` reconciles a stale PID against the live process table), but a reboot mid-session was not staged. |
