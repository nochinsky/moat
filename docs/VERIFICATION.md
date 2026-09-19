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
  note       mknod denied in userns (kernel policy): /dev nodes are bind-mounted from
             the host's device nodes (rw: a device is an interface, not a file). No host *data* is mounted.
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
measurements taken inside a real boot. The transcript below is from a box whose
network policy is `open`; in the default `filtered` mode the middle two lines
are not exposures at all but `check`s that must pass (`pass egress filtered`,
`pass host loopback reachable`, see §L), and the credential and the bundle
redaction are exactly as shown here.

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
          the sandbox reached 1.1.1.1:443. It shares the host's network namespace (egress mode
          "open"), so the agent can install dependencies AND exfiltrate anything it can read,
          including the project and the injected credential. A new environment defaults to
          "filtered".
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
  provider-side scoping, which is v2; until then the key has to be disposable.
* Egress policy narrows exfiltration instead of ending it. The default
  `filtered` mode keeps the box away from the host's loopback and out of
  arbitrary addresses (`docs/SPEC.md` §7.3, verified in §L), but an *allowlisted*
  address, and DNS, can still carry data out. Treat the allowlist as a limit on
  the blast radius, not as confidentiality.
* Tool-level permissions would not have changed any of these measurements:
  every one came from a single `bash` call. This is why the "no deny rules" is
  not the problem, see `docs/SPEC.md` §1.3.

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
  "provisionMs": 1022,
  "provisionFromImageCache": true,
  "imageCache": "/home/user/.moat/cache/images/alpine-3.21.4-50303c72c8d1.tar.gz",
  "provisionSteps": [
    {
      "name": "extract cached image",
      "ms": 864
    }
  ],
  "baselineSnapshot": {
    "name": "baseline",
    "bytes": 81976993,
    "linked": true
  },
  "copyIn": {
    "transport": "git",
    "head": "c1ac17d4d20d6924cdb30e548f6852f1e277e21f",
    "branch": "main",
    "dirty": true,
    "trackedChanges": 1,
    "untrackedFiles": 1,
    "digest": "c73dfe12c6e22b9fd80294de7eea6122c85a25769a490fc97f4d28530d855158",
    "files": 3,
    "bytes": 126,
    "suspectSecrets": [],
    "skippedFromCopy": [],
    "hostState": "git:c1ac17d4d20d6924cdb30e548f6852f1e277e21f:af703fa3b275a51f"
  },
  "copyInMs": 76,
  "provider": {
    "opencodeID": "moat",
    "native": false,
    "label": "custom OpenAI-compatible endpoint"
  },
  "model": {
    "id": "moat/mock-model"
  },
  "bundle": {
    "curated": [
      "read",
      "write",
      "edit",
      "apply_patch",
      "glob",
      "grep",
      "bash",
      "todowrite",
      "question"
    ],
    "excluded": [
      "skill",
      "webfetch",
      "websearch",
      "task"
    ],
    "preset": "core"
  },
  "egress": "open",
  "status": "running",
  "port": 42021,
  "pid": 61565,
  "bootMs": 8891,
  "totalMs": 10131,
  "readyCheck": "GET /config -> 200",
  "credential": {
    "provider": "moat",
    "fingerprint": "sha256:7726b438889c7f57",
    "expiresAt": "2026-09-19T19:05:28.621Z",
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
confirms what opencode loaded (the suite prints the fields it checks; the committed
copy is `test/evidence/audit.jsonl`):

```
$ moat logs audit
{"phase": "config", "permission": {"skill": "deny", "webfetch": "deny", "websearch": "deny", "task": "deny", "*": "allow"}, "toolOmissions": ["skill", "webfetch", "websearch", "task"]}
```

`"*": "allow"` is the rule that matches every curated tool, so no approval prompt
can fire. The four `deny` entries are not approval rules: opencode compiles moat's
`tools: {name: false}` into permission denies *before* the plugin's config hook
runs, and the hook has to accept exactly that shape and nothing else. This record
is also the proof that the hook ran at all. The check used to demand exactly
`{"*":"allow"}`, so it threw on every boot; opencode logs a plugin hook error and
carries on, which is why the only symptom for several commits was an ERROR line in
a boot log and a config record that never appeared.
`test/unit/plugin-guard.test.ts` asserts both halves: the merged shape is accepted
with the record written, and an approval rule or a deny moat did not ask for is
refused.

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

isolation (14 checks)
  pass  host project not reachable     /home/user/moat-demo/project is absent inside the sandbox
  pass  host home not reachable        /home/user is absent inside the sandbox
  pass  host canary unreadable         /home/user/.moat/canary (mode 600, exists only on the host) is unreadable
  pass  no host ssh directory          host /home/user/.ssh absent; sandbox /root/.ssh absent
  pass  no host env forwarded          no variable from the host environment reached the sandbox; present: DEEPSEEK_API_KEY, HOME,
                                       LANG, LC_ALL, MOAT_CREDENTIAL_EXPIRES_AT, MOAT_CREDENTIAL_FINGERPRINT, MOAT_CREDENTIAL_TTL_SECONDS,
                                       MOAT_INJECTED_CREDENTIAL, MOAT_MODEL, MOAT_MODEL_ID, MOAT_PROVIDER_BASE_URL, MOAT_SANDBOX,
                                       OPENCODE_SERVER_PASSWORD, PATH, PWD, SHLVL, TERM (plus moat's own DEEPSEEK_API_KEY,
                                       MOAT_CREDENTIAL_EXPIRES_AT, MOAT_CREDENTIAL_FINGERPRINT, MOAT_CREDENTIAL_TTL_SECONDS,
                                       MOAT_INJECTED_CREDENTIAL, MOAT_MODEL, MOAT_MODEL_ID, MOAT_PROVIDER_BASE_URL,
                                       OPENCODE_SERVER_PASSWORD, which is the credential, disclosed below)
  pass  no host data mounts            13 mounts; none reference a host filesystem path
  pass  sandbox pid 1                  pid 1 is "sh", 4 visible processes
  pass  own mount namespace            sandbox mnt:[4026532312] vs host mnt:[4026532219]
  pass  own pid namespace              sandbox pid:[4026532315] vs host pid:[4026532221]
  pass  own user namespace             sandbox user:[4026532311] vs host user:[4026531837]
  pass  own uts namespace              sandbox uts:[4026532313] vs host uts:[4026532220]
  pass  own ipc namespace              sandbox ipc:[4026532314] vs host ipc:[4026532208]
  pass  uid mapping                    uid_map "0 1000 1", uid 0 inside is the calling user outside
  pass  device nodes are the only host mounts 6/6 device node bind(s), rw like every rootless runtime: /dev/full, /dev/null,
                                       /dev/random, /dev/tty, /dev/urandom, /dev/zero

  note  network namespace shared       sandbox and host share net:[4026531833]. The agent has the host's network position.
                                       Documented v0 limitation; fixed in v1/v2 (docs/SPEC.md).

mount table inside the sandbox
  /dev/full||/full||rw,nosuid,relatime||devtmpfs none rw,size=3945424k,nr_inodes=986356,mode=755
  /dev/null||/null||rw,nosuid,relatime||devtmpfs none rw,size=3945424k,nr_inodes=986356,mode=755
  /dev/pts||/||rw,relatime||devpts devpts rw,mode=620,ptmxmode=666
  /dev/random||/random||rw,nosuid,relatime||devtmpfs none rw,size=3945424k,nr_inodes=986356,mode=755
  /dev/shm||/||rw,nosuid,nodev,relatime||tmpfs tmpfs rw,uid=1000,gid=1000
  /dev/tty||/tty||rw,nosuid,relatime||devtmpfs none rw,size=3945424k,nr_inodes=986356,mode=755
  /dev/urandom||/urandom||rw,nosuid,relatime||devtmpfs none rw,size=3945424k,nr_inodes=986356,mode=755
  /dev/zero||/zero||rw,nosuid,relatime||devtmpfs none rw,size=3945424k,nr_inodes=986356,mode=755
  /dev||/||rw,nosuid,relatime||tmpfs tmpfs rw,mode=755,uid=1000,gid=1000
  /proc||/||rw,relatime||proc proc rw
  /run||/||rw,nosuid,nodev,relatime||tmpfs tmpfs rw,mode=755,uid=1000,gid=1000
  /tmp||/||rw,nosuid,nodev,relatime||tmpfs tmpfs rw,uid=1000,gid=1000
  /||/home/user/.moat/envs/18620c2c4f34/rootfs||rw,relatime||ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered
```

That is the complete table — all 13 entries, not a filtered view. Reading it
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

The human output labels the kind of start, so a warm boot is never reported
as a cold one (`cold start … (image built)` vs `warm start … (image reused)`, the
latter measured in `test/evidence/up-short-ttl.txt`). `moat up --json` reports the
breakdown:

```json
$ moat destroy --yes && moat up --json …          # first boot for this project
{
  "provisionMs": 1022,
  "provisionFromImageCache": true,
  "imageCache": "/home/user/.moat/cache/images/alpine-3.21.4-50303c72c8d1.tar.gz",
  "provisionSteps": [ { "name": "extract cached image", "ms": 864 } ],
  "baselineSnapshot": { "name": "baseline", "bytes": 81976993, "linked": true },
  "copyInMs": 76,
  "bootMs": 8891,
  "totalMs": 10131,
  "readyCheck": "GET /config -> 200"
}
```

| measurement | this run |
| --- | --- |
| `totalMs` — `moat up` start to server ready | **10 131 ms** |
| `provisionMs` — image extraction | 1 022 ms |
| `copyInMs` — clone + dirty-tree replay | 76 ms |
| `bootMs` — spawn namespaces to `GET /config -> 200` | 8 891 ms |
| warm start (`provisioned: false`) | **4 153 ms** |

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

$ grep -iE 'expired|agent exited' ~/.moat/envs/*/rootfs/var/log/moat/boot.log
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
Reproduce with `DEEPSEEK_API_KEY=... bash test/e2e-live.sh`. Full transcript:
`test/evidence/live-session.txt`, 398 lines.

The environment takes the **default** network policy: the suite passes no
`--egress` flag. The fifth section of the transcript then measures that policy in
the same box that did the work, rather than trusting the boot line — the
allowlisted provider answers (HTTP 401 without a key) and an address outside the
allowlist times out (`curl-exit=28`).

### The setup

A small Node project (`slugkit`) whose test suite genuinely fails: 1 pass, 5
fail. Deliberate bugs in a `slugify()` — no whitespace collapsing, no trimming,
no punctuation handling, no accent transliteration. The sandbox was booted with
`--profile node` and the real provider:

```
$ moat up --model deepseek-flash --profile node --credential-env DEEPSEEK_API_KEY
model: deepseek/deepseek-flash (context 1M, out 384k)
agent branch: moat-session-2026-09-19-15-15
✓ sandbox up, cold start 17.98s (image built)
```

### What the agent did

Prompt: *"npm test is failing. Run it, find the bug in src/slugify.js, and fix it
so the whole suite passes. Then run npm install and verify the CLI works end to
end. Commit everything to the branch you are on, and report the final test
output."*

Fourteen tool calls, all completed, in a sensible order:

```
bash  cat package.json; ls -la; git status; git log --oneline -5
read  src/slugify.js
glob  (found test/slugify.test.js)
bash  ls -R src test; npm test 2>&1 | head -100
read  test/slugify.test.js
read  src/cli.js
edit  src/slugify.js
bash  npm test 2>&1 | tail -20
bash  npm install 2>&1 | tail -15
bash  node src/cli.js "  Crème Brûlée  " ; node src/cli.js --version
bash  git add -A && git commit -m "fix(slugify): handle whitespace, punctuation and accents"
write  .gitignore
bash  git rm -r -q --cached node_modules && git add .gitignore package-lock.json && git commit
bash  npm test 2>&1
```

The `npm install` in the middle is worth noting twice over: it worked — the npm
registry is on the allowlist — and the agent then noticed it had staged
`node_modules`, wrote a `.gitignore`, and removed it from the index in a second
commit rather than leaving it in the branch.

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

### K. The host-side git and apply regressions, as tests that run in CI

Two classes of defect found in review had no guard: the host executing
agent-controlled git config, and `moat apply` writing the wrong bytes. Both are
now covered by `test/unit/`, which needs no sandbox and therefore runs in the
workflow that cannot create user namespaces.

```
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
✔ the curated tool list has one source of truth
✔ the plugin refuses a permission rule that is not exactly allow-all
✔ the plugin rejects a patch move out of the workspace and allows one inside it
✔ a completed call is recorded as completed, not as success
✔ the permission invariant is exactly allow-all, not merely non-deny
✔ MOAT_SANDBOX_ENV only carries OPENCODE_/MOAT_ names and never a managed one
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
ℹ tests 49
ℹ pass 49
ℹ fail 0
```

Each guard was checked against the old behaviour before it was trusted. The
multi-merge, two-space-name and missing-baseline scenarios fail when run against
the pre-fix module (`git show HEAD:sync/apply.ts`); the git-hardening tests
assert in their first line that plain git *does* execute the planted
`core.fsmonitor`, and that the pre-commit hook *does* run, before asserting that
`sandboxGit` does neither. The copy-in test replays the old pipeline inside the
test and asserts it cannot reproduce the host bytes. The mount test asserts the
rendering includes mountinfo's root field, without which a bind of a host
directory is indistinguishable from a device.

One correction to the review that prompted this work: the old drift fingerprint
was said to be blind to a byte change because both values decode to U+FFFD. It
was not — the hashed diff string includes git's `index <old>..<new>` line, whose
blob hash is computed over raw bytes. Hashing the patch bytes is still the better
fingerprint (it does not depend on git's text escaping), but the drift test above
is a guard, not an old-behaviour regression, and it says so.

The `--fresh` and stale-pid rules are behavioural and were exercised against a
real sandbox instead: `--fresh` while running refuses; `--fresh` with an
uncommitted file and no `--yes` refuses and names the count; `--fresh --yes`
reboots over the re-copied project; and `moat down` with `state.json` pointed
at an unrelated live process warns and leaves that process running.

### L. Egress policy: its own namespace, a pinned datapath, an allowlist, and the default

`bash test/e2e-egress.sh` needs no key: reachability is proven by the provider
answering 401 to an unauthenticated request, which a stub on the host's loopback
cannot fake from inside the namespace. It runs three boots: `--egress isolated`,
the same environment restarted `--egress filtered`, and then a **fresh project
with no `--egress` flag at all** to prove what a new environment gets.

```
$ bash test/e2e-egress.sh
  pass  the box booted with isolated egress
  pass  status reports running
  pass  status reports isolated egress
  pass  the port forward works
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
first assertion is what keeps the second from passing vacuously — the tranche
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
is two-sided — an address outside the allowlist (1.1.1.1:443) must be refused
**and** the allowlisted provider must be reachable — so a ruleset that drops
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
a bound on where the box sends data during normal work — a runaway install, a
prompt-injected `curl`, an accidental upload — not containment of an agent that is
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
```

The suite asserts the message (`an unresolvable provider fails the boot`). Other
unresolved hosts are a warning; ephemeral boots only warn, because `moat exec` may
be exactly how the box is being diagnosed and `moat doctor`'s two-sided check
reports the result as a failure.

#### The reinstall check, and what it found

`apk` trusts its database over the filesystem. Deleting `/usr/sbin/nft` without
touching apk's records left `apk add nftables` with nothing to do, and every
filtered boot then failed with `[moat] filtered egress needs nft inside the box,
and this image has none`. The suite's check deletes the binary and asserts the
next ephemeral boot reinstalls it and is still filtered; `ensureFilterTool` now
clears the stale package entry (`resetFirst`) and installs again when the binary is
still missing, and every path that boots a filtered box calls it, not just
`moat up`. The check is what found the bug, and it was red before the repair.

What remains open is the shape of the allowlist, not its existence: it is an IP
snapshot resolved on the host when the box boots, so a host that rotates to an
address outside it is unreachable until the next `moat up`; it cannot express
per-host ports; and DNS to slirp's resolver (`10.0.2.3:53`) is itself an outbound
channel. The policy also does not change the credential exposure (§1.2 of the
SPEC): the agent still reads the key, and an allowlisted address or DNS can still
carry it out.

---

### M. Host-side writes into an agent-controlled rootfs cannot be redirected

The rootfs is persistent and the agent is root inside it, so it can replace one of
its own directories with a symlink whose target string names a host path. The
kernel resolves that string for the **host** process on the next boot. Measured
with the old write path, calling the bundle installer directly with
`/root/.config/opencode` symlinked to a directory outside the rootfs:

```
installBundle completed without complaint
  host-side AGENTS.md WAS CREATED (3834 bytes)
target dir contents: [ 'AGENTS.md' ]
```

`installBundle` runs on **every** boot, so that was a file written into a
directory outside the sandbox on every `moat up`, `moat exec` and `moat doctor`.

Every host-side write into the rootfs now goes through `lib/rootfs-fs.ts`: each
path component is `lstat`ed and a symlink or non-directory is refused, missing
parents are created, the content is written to a temp file opened
`O_EXCL|O_NOFOLLOW`, the file that was actually opened is verified through
`/proc/self/fd`, and it is renamed into place — rename replaces a symlink at the
target instead of writing through it. `chmodRootfsDir` and the reads of
agent-controlled files (`moat logs sandbox`, `moat logs audit`, the
installed-bundle report) use the same guard.

The boot log is the same story one step further: the boot script used to
redirect to `<rootfs>/var/log/moat/boot.log` **by path**, so a symlink swapped into
the agent-writable rootfs could point that write at a host directory. The host now
opens and verifies the log through the guard and passes it as descriptor 3, and
the script dups it (`exec 1>&3 2>&3`).

`test/unit/rootfs-write.test.ts` covers it: a symlinked parent is refused with the
host directory left empty, a symlink at the file itself is replaced rather than
followed, `..` is refused, chmod does not reach through a symlink, a symlinked
boot log reads as nothing instead of printing a host file, an agent-sized log is
truncated to its tail instead of read whole, the boot script dups a descriptor and
never names the path, and opening the log for append refuses a symlink. Every one
of those tests was watched failing with the old behaviour restored.

Snapshot extraction needs no guard of its own, and that was measured rather than
assumed: GNU tar refuses to write through a symlink its own archive created
(`Cannot open: Not a directory`, host target untouched), and `restoreEnv` treats a
non-zero tar exit as a failed restore and rolls back.

### N. The environment inventory survives a deleted project directory

An environment whose project directory no longer exists is exactly the one that
leaks disk, and it used to be invisible: `listEnvs()` rebuilt its paths from the
recorded `projectDir` through `envPaths()`, whose `realpath()` throws for a
missing directory, and the `catch` dropped the environment. Two environments
holding 800 MiB were invisible that way on this machine — `moat status --all` did
not list them and `moat destroy --all` did not reclaim them.

The directory name is the id now, a directory whose state cannot be read is still
listed, and `moat destroy` takes paths rather than a project directory. The extras
suite proves it with a throwaway `MOAT_HOME` (so `destroy --all` never touches the
real store): one environment with a project directory that is gone and one with
unreadable state.

```
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

Five small defects of the same shape: an argv that becomes a path or a number
without being checked, plus one flag whose unit depended on where it was read. They
are asserted where they cost nothing — the extras suite, section R — and the pure
part has a unit test.

```
log name: refused instead of reading a host file
--tail: refused instead of silently printing the whole log
models <provider>: refused instead of silently listing DeepSeek
--port: refused before provisioning, not ninety seconds into a boot
--timeout: seconds, not milliseconds, for the boot readiness wait
--tools: refused before provisioning
--log-level: refused instead of silently becoming INFO
--model with an empty value: refused
--base-url with an empty value: refused
```

What they replace, measured: `moat logs ../../../../../tmp/moat-traversal` printed
`/tmp/moat-traversal.log`, a host file outside the environment (`moat logs` joined
argv into the environment's log directory); `--tail abc` parsed to NaN and silently
meant "the whole file"; `moat models bogus` ignored its argument and listed DeepSeek
with exit 0; and a typo in `--port` survived provisioning, booted a server that could
not bind, and surfaced ninety seconds later as "opencode serve did not come up".

Four flags were validated at their use site, which is after provisioning, or not at
all: `--tools bogus` survived the copy-in before the provider section rejected it;
`--log-level chatty` fell through the uppercase set in `serveEntryScript` and
silently became INFO (measured: `--log-level debug` produced DEBUG lines after the
fix and INFO lines before it); `--model ""` booted a config whose model id was
empty; and `--base-url ""` booted an empty base URL. All four are refused before
provisioning now, and the extras checks assert the *absence* of a provisioning line
in those captures, so a regression to late validation fails the suite.

`--timeout` is the same kind of mistake with a worse symptom: the agent loop and
the checks runner take it as **seconds** (the turn default is 2700), and the boot
readiness wait read it as **milliseconds**, so `moat up --timeout 600` failed with
`opencode serve did not come up (GET /config -> TypeError after 600ms)` — a
ten-minute budget turned into an instant failure. One flag, one unit: seconds
everywhere, documented in `moat --help`.

### P. A live view that can no longer be live says so

The REPL learns everything — streamed text, tool rows, the question prompt and
the `session.idle` that ends a turn — from one long-lived response (`GET /event`),
and it subscribes once. The SDK's SSE client never ends that response on its
own: its loop is `while (true)`, and a failed connection goes to `onSseError`,
sleeps with backoff (up to 30s) and reconnects, forever, without throwing and
without ending the generator. A box stopped mid-turn therefore does not look like
a failure. It looks like a quiet one.

Measured through a pty, against the stub: a turn in flight, `moat down` underneath
it, and — before this — no line about the stream at all. The spinner kept
turning and the next message got the sentence reserved for a busy agent:

```
queued — the agent will pick this up when the current step finishes
› could not send: fetch failed
```

The turn was already over and the answer could never arrive. Both subscribe sites
now pass `sseMaxRetryAttempts: 1` (one attempt, no reconnect) and an `onSseError`
handler, which turns that failure into an end the consumer can see. The same pty
scenario now prints, within a second of the box dying:

```
› lost the event stream from the sandbox: terminated
›   every event of a turn arrives on that one stream, so this view cannot
›   continue. The turn may still be running inside the box: moat up restarts
›   it, and a new moat attach opens this session where it left off.
› › are you still there
  not sent: the event stream is gone, so the answer could not be shown.
›   leave with /quit, then moat up and moat attach to carry on in this session.
```

`test/repl-stream-loss.py` is the whole reproduction — a real pty, a real box, a
real turn in flight, a real `moat down` — and all six of its checks pass; the suite
runs it as section S. The pre-fix run of the same script failed three of the six,
and the paragraph above is the transcript it printed instead.

The one-shot path has the same seam with a different symptom: `driveStreaming`
waits for `session.idle`, so with the SDK's default it would reconnect forever
while the turn's events were gone, printing "no output for 30s" until the
45-minute budget expired. With the retry off the generator *completes* instead of
throwing, which used to leave the loop with `idle === false` and no error at all:
`moat run` returned the partial transcript as a success.
`test/unit/session-stream.test.ts` covers both halves — it asserts the subscribe
options at the seam, and that a clean end before `session.idle` is reported as
`the event stream ended mid-turn`. Both assertions were watched failing with those
two changes reverted (2 of its 4 tests fail).

What this does not cover: a stream that stays open and simply goes quiet, with no
FIN and no error. The box dying closes its sockets, which is what was measured;
a silence watchdog on the server's 10s heartbeat does not exist.

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
bundle (installed bundle config + plugin load record + plugin config record)
  curated    read, write, edit, apply_patch, glob, grep, bash, todowrite, question
  excluded   skill, webfetch, websearch, task
  omissions confirmed by opencode: skill, webfetch, websearch, task

registry (everything opencode knows about, NOT what the model sees)
  + apply_patch   + bash   + edit   + glob   + grep   + question   + read
  + todowrite   + write
  - invalid   - skill   - task   - webfetch   - websearch

! opencode 1.18.31 cannot stop advertising: webfetch, skill, task.
  The bundle refuses to execute them (docs/UPSTREAM-CANDIDATES.md).
```

The header names the three records the claims come from: the config moat installed,
what the plugin loaded, and the plugin's `config` record — which is what opencode
handed the plugin at load time. Until this round that third record was never read
(`moat tools` looked in the wrong file for it) and the plugin's config hook had
never completed, so "omissions confirmed by opencode" was moat's own declaration
wearing the plugin's name. It is now the plugin's account of the merged config.

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
| v2 (provider-side credential revocation and spend caps, concurrent sandboxes) | explicitly gated on v0 *and* v1 passing. Egress rules landed ahead of v2 and are verified in §L. |
| Model quality, as opposed to model reachability | a real DeepSeek session is verified above. That is one task, one model, one run — a smoke test with teeth, not a benchmark. |
| That a reasoning-effort level changes any particular answer | the level provably reaches the provider (see "Secondary claims" H). Whether `max` answers better than `default` is model behaviour, and one sample per level shows nothing. |
| Non-DeepSeek providers | moat is DeepSeek-only by design; `--base-url` exists for a gateway or a local model and is exercised against a stub, but no second hosted provider was wired up or called. |
| The `countUnfetched` / host-drift logic under adversarial git states | both branches were exercised (drift with unpreserved sandbox commits → warning; drift with everything already fetched → automatic re-copy), but not things like a rebased sandbox branch or a detached host HEAD. |
| The `browser`, `db`, `java`, `go`, `rust`, `cc` and `net` profiles | package names were resolved against the real Alpine 3.21 indexes, and the `node`/`python` profiles were installed and exercised end to end. The others were not installed here, to keep the suite under five minutes. |
| The absolute correctness of a cost figure against a DeepSeek invoice | it is the published table applied to the billed token counts, and it reconciles exactly with opencode's own arithmetic on the same numbers (above). It is not compared against a real bill. |
| Rendering in terminals other than the ones tested | verified through a pty at 80 and 100 columns, and in plain mode via `NO_COLOR`. Narrow widths, unusual `TERM` values and terminal resize mid-turn were not exercised. |
| `/undo`, `/redo` and `/compact` against a real model | the calls are exercised against the stub and the server accepts them, but summarisation is model-driven and the stub cannot summarise: it answers `/compact` by trying to call a tool, which the server rejects with `Tool call not allowed while generating summary`. |
| Exfiltration through an allowed channel | §L verifies that the allowlist admits the provider and refuses an arbitrary address, and that the host's loopback is unreachable on both routes. It does not attempt to push data out *through* an allowlisted address or over DNS, both of which remain possible by construction. |
| Behaviour under host reboot / kernel upgrade with a live env | the environment is designed to survive (`state.json` reconciles a stale PID against the live process table), but a reboot mid-session was not staged. |
| Project file names that are not valid UTF-8 | refused with the offending bytes before anything is copied (`assertAddressableNames`, `test/unit/fs-names.test.ts`, extras §Q). Byte paths through every host-side walk do not exist yet, so such a project cannot be sandboxed at all — a refusal, not support, and not a silent drop. |
| A live event stream that stays open and goes quiet | the *end* of the stream is detected and reported (secondary claim P), and the box dying closes its sockets, which is the case measured. A connection that stays open while delivering nothing — no FIN, no error — is not detected: there is no watchdog on the server's 10s heartbeat. Nothing observed produced one. |
