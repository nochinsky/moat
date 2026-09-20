# Review findings (open)

Two fresh-context reviews of the sandbox, sync and secrets layers were run against this
tree. This is what they found that is still true after the opencode runtime was deleted.
Nothing here is fixed yet; it is a work list, ordered by what it protects. Line numbers are
approximate — read the code.

## Host filesystem

1. **`moat apply` can write outside the project.** `sync/apply.ts` joins the change path onto
   `projectDir` with no lexical containment check, and `copyFileSync` follows an existing
   symlink at the destination. A symlink the agent can cause to exist in the project routes an
   agent-authored file to whatever it points at. A dangling symlink is read as a deletion and a
   live one is materialised as a regular copy of its target, so symlink edits also change file
   *type* on the host, and sandbox-internal targets (`/etc/...`) get copied out as project
   files. This is the one finding that crosses invariant 1's spirit: the box is not mounted, but
   a write can still land outside the project.
2. **A failed device bind can leave a regular file at `/dev/null`.** `sandbox/launcher.ts` runs
   `: > "$N/dev/<node>"` before the bind and swallows a failure, so a box can boot with an
   empty regular file instead of the device: `> /dev/null` then fills the rootfs, and a failed
   `devpts` mount leaves `/dev/ptmx` dangling. The boot should verify each bind (and the mount)
   and refuse rather than continue.
3. **A propagation failure at the root mount is silent.** `mount --make-rprivate / || true` is
   followed by `mount --bind "$R" "$N"` where `$N` is on the host filesystem: if the first
   fails, the sandbox mount can propagate into the host namespace with no diagnostic.
4. **`chroot` is the only thing setting the cwd.** The boot script never `cd /` itself, so a
   host whose `chroot` preserves the working directory hands the box a cwd above its root.

## Checks that cannot fail

5. **The mount check cannot detect a host bind.** In `sandbox/isolation.ts` the "no host data
   mounts" pattern matches root-relative mountinfo, where a bind is rendered as
   `fstype device` rather than a source path, so it can never match; and the device-node row is
   hardcoded `ok: true` and skipped when zero binds are found. The check that exists to prove
   invariant 1 prints a claim it never verified.
6. **The `pid 1` assertion passes on an empty `/proc`.** `wc -l` of 0 and a magic `<= 12`
   threshold mean the row can pass while measuring nothing.
## Process and budget

7. **A check that traps SIGTERM hangs the CLI.** `sandbox/checks.ts` runs the project's test
   through `timeout N sh -c <JSON.stringify(cmd)>` — `JSON.stringify` is not shell quoting, so
   `$`, backticks and newlines stay live — with no `--kill-after`, and `runInSandbox` has no
   host-side timeout and accumulates stdout in a host string. A hostile or careless check can
   hang or exhaust the host.
8. **`moat apply` trusts the baseline ref it recorded.** `state.baselineCommit` is never
   compared against `refs/moat/baseline` in the agent-writable repository, so a moved or deleted
   ref yields an empty plan: "nothing to apply: the directory already matches the sandbox", exit
   0, agent work silently ignored.
9. **Mode-only changes never reach the host.** `sync/apply.ts` hashes content only and
   short-circuits equal hashes, so a `chmod +x` inside the box is not a change as far as apply
   is concerned.
10. **Non-UTF-8 bytes break copy-in and the drift fingerprint.** `sync/copyin.ts` captures
    `git diff --binary HEAD` as a UTF-8 string and replays it (a latin-1 file makes `git apply`
    fail with only a warning, and the box then works on stale content), and `hostState` hashes
    that same mangled text, so distinct byte changes can share a fingerprint.
11. **`hostHash === null` resurrects a deleted file.** When the user deleted a baseline file and
    the agent modified it, the plan pushes `kind:"add"` without consulting `baseHash` instead of
    reporting the conflict.
12. **`--credential <literal>` puts the key in host argv** (`ps`, shell history). The risk
    notice talks about disposability, not about the flag itself.

## Where these came from

The reviews were run before the opencode deletion; findings that only concerned the deleted
modules are dropped, and the ones AGENTS.md already records as fixed after that read (pid
identity, the boot window, boot-script names and the host log fd, snapshot names and staged
restore, digest-pinned downloads and `partPath`, the rootfs symlink guard, the doctor's
injected names) are not repeated. `--runtime`, the bundle/plugin and `moat env`/`tools` findings
are moot with the runtime gone.
