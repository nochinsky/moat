# Review findings: checked, and what holds them

Two fresh-context reviews of the sandbox, sync and secrets layers were run against an earlier
revision of this tree. Every finding was then re-checked against the code. **This is not a work
list:** most of what the reviews reported had already been fixed, and the rest is fixed in the
round that rewrote this file. It is kept as the record of the re-check, so the next reviewer does
not redo either half.

Any future finding belongs here as a new section, with the check that holds it (or the note that
nothing does yet).

## Were real, fixed in the same round

1. **A failed device bind, devpts mount or private-propagation step booted anyway.** `: >` created
   a regular file at `$N/dev/<node>` and the bind's failure was swallowed by `|| true`, so a box
   could boot with a `/dev/null` whose writes land in its own rootfs, a `/dev/urandom` that
   returns nothing, and no symptom. The boot now makes the mount tree private or refuses, binds
   each device without a fallback, checks every result with `[ -c ... ]`, proves `/dev/pts` is
   mounted, and refuses otherwise. Held by `test/unit/rootfs-write.test.ts` ("the boot refuses a
   device table or a mount tree it could not build"), by the doctor row **device nodes are real
   devices** (measured inside the box), and by the control in `test/e2e-codex.sh` §3 that breaks
   `/dev/null` in a live box and shows the same measurement reporting it.
2. **A bind of the host's `/` was exempt from the mount check.** `analyseMounts` skipped any line
   whose root field was `/`, because proc, tmpfs and devpts legitimately have `/` there — which
   also skipped `mount --bind / $N/mnt`, the one mount that hands the box every host file. The
   exemption is by filesystem now. Held by `test/unit/doctor-mounts.test.ts` ("a bind of the host
   root is flagged, while a pseudo-filesystem mounted at one is not"), which fails against the
   previous revision.
3. **The chroot inherited the working directory.** The boot relied on `chroot(1)`'s own `chdir`;
   the script now `cd / && exec`s the entry script, so the barrier does not depend on a host tool's
   default. Held by the same boot-script test.
4. **`--credential <literal>` put the key in host argv with no warning.** It still does — that is
   the flag's purpose — but the boot now says so at the point of use (visible in `ps`, kept in
   shell history) and names `--credential-env` and the credential store as the better path.

## Were already held, with the check that holds them

* **`moat apply` writing outside the project, or through a symlink.** `safeDestination` resolves
   the project, rejects `..`, and rejects a symlinked component whose target leaves the tree;
   `copyAtomic` unlinks a symlinked destination before writing. `test/unit/apply.test.ts` covers
   both the path escape and a symlink the agent created (`link` changes are applied as symlinks).
* **Mode-only changes never reaching the host.** `kind: "mode"` is planned and applied;
   `test/unit/apply.test.ts` has the `chmod` case.
* **The user deleted a baseline file and the agent changed it.** Planned as a conflict, never
   written; `test/unit/apply.test.ts` ("a file the user deleted and the agent changed is a
   conflict"). The `hostHash === null` shape the review described does not exist in this revision.
* **`refs/moat/baseline` moved or missing under the merge.** `materialiseBaseline` reports a
   missing ref as a plan-level problem (never "nothing to apply"), and `cmd/main.ts` compares the
   ref's commit against the one `state.json` recorded and refuses when it moved. Held by
   `test/unit/apply.test.ts` ("a missing baseline is reported ...") and the comparison at
   `cmd/main.ts`.
* **Non-UTF-8 bytes corrupting copy-in or the drift fingerprint.** The worktree diff goes to a
   *file* (`git diff --binary --output=`), and `hostState` hashes those bytes rather than a decoded
   string — the comment there names the latin-1 case. Binary files ride in the same diff.
* **The checks runner's timeout and quoting.** `checkScript` uses `shellQuote(command)`,
   `timeout --kill-after`, and reports 124/137 as a timeout; `runInSandbox` takes a host-side
   `timeoutMs` backstop (the runner passes limit + 30s) and caps captured output
   (`MAX_CAPTURED_OUTPUT`), keeping the tail.
* **Host-derived strings interpolated into the probe script.** They go through `shellQuote`
   (`sandbox/isolation.ts`), not `JSON.stringify`.
* **The mount check being unable to match a host bind at all.** It reads the mountinfo *root*
   field (`MOUNT_FIELDS_AWK`), which is exactly where a bind names its host path;
   `test/unit/doctor-mounts.test.ts` asserts the root field is rendered and that a host bind is
   flagged while moat's own rootfs and the six devices are not.
* **The device-node row being hardcoded `ok: true` and skipped when nothing was found.** It is
   `deviceBinds.length === 6` and always pushed.
* **The `pid 1` row passing on an empty `/proc`.** It requires the visible process count to be at
   least 1 and the comm not to be `init`/`unknown`.
* **`moat up`'s `isGitRepo` guard missing an `await`.** Every call site is awaited.
