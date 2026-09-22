# Portability: what is measured, what a container backend would cost, and what is not measured

Phase 4's question is whether moat should escape Linux. Invariant 7 ("no container runtime, no
daemon") is exactly what blocks macOS, Windows and CI runners, so answering it means either breaking
that invariant deliberately or accepting the narrow audience.

This page exists so the decision does not rest on a spike nobody ran. It records **what was
measured**, **what a container backend would cost** (a static analysis of this tree, not a guess),
and **what remains unmeasured** — with the script that closes each gap.

Everything here is reproducible: `bash test/portability-spike.sh`.

---

## 1. What is measured

From `test/evidence/portability-wsl2.txt`, produced by the spike on the host the whole e2e suite
runs on:

```
  uname     Linux 6.18.33.2-microsoft-standard-WSL2 x86_64
  platform  WSL2 (a Linux kernel under Windows)
  distro    Ubuntu 26.04 LTS
  uid       1000
  cgroup    cgroup-v2

  probe: unshare --user --map-root-user --mount sh -c 'mount -t tmpfs none <scratch>'
  MEASURED  user namespaces work — unshare, and a mount inside them, succeeded

  absent    podman / docker / nerdctl / lxc / incus / systemd-nspawn
  BLOCKED   /dev/kvm exists but this user cannot open it — crw-rw---- root:kvm
```

**WSL2 works today.** That is not an inference from a probe: the sandbox suites that produce
`docs/VERIFICATION.md` are run on this host, so the evidence *is* the WSL2 datapoint. moat's
`doctor` says the same thing every run (`platform linux x64 wsl2 userns=yes`).

**macOS and Windows are not measured here**, because this host cannot measure them: they are a
different OS with no Linux namespaces at all, and a probe from here would say nothing about the
kernel moat would be given.

**The container backend is measured** — see section 2, and `test/evidence/portability-podman.txt`.
The first version of this page could not take that reading (no container runtime was installed and
installing one needed root this account does not have), so it derived the cost from the tree
instead, and got it wrong. The reading was taken afterwards, on the same host, with rootless podman
installed.

The spike's own first version reported `BLOCKED — user namespaces do not work here`, which was a
false negative produced by the probe mounting onto a path that did not exist inside the namespace,
not by the kernel. Found because the claim contradicted a suite that passes; the fix is in the
script, and the lesson is the one this repository keeps relearning — a probe that cannot succeed and
a probe that cannot fail look identical until you check them against something already known.

---

## 2. What a container backend would cost — measured, not derived

> **This section was rewritten after the measurement below. The first version derived the cost from
> this tree without running a container runtime, and its central sentence was wrong.** It said "a
> container image is not a persistent, agent-writable directory". With `--rootfs`, it is. That is
> the difference between a cost estimate and a guess, and it is why the spike now takes the reading
> instead of arguing about it.

Measured on the host above with rootless podman 5.7.0, via `bash test/portability-spike.sh`
(section 4), captured in `test/evidence/portability-podman.txt`:

```
MEASURED  podman is usable by this user — rootless, no sudo
MEASURED  --rootfs accepts a plain directory — moat's rootfs is a directory, not an image
MEASURED  an agent's writes persist into it — inside uid=0; the file survived the container
MEASURED  all six namespaces differ from the host — pid mnt user net uts ipc
MEASURED  /dev is populated by the runtime — moat's six host device binds would not be needed
MEASURED  the host's home is not inside — and no host data is mounted
MEASURED  network modes are the runtime's own — --network=none gives 1 interface(s)
```

So four of the things this document previously listed as costs are **not costs**:

* **the persistent directory rootfs** — `--rootfs` takes a plain directory, the agent runs as uid 0
  inside it, and a write made inside *lands in that directory*. Snapshots, the image cache key and
  `installRuntimeBinary` keep working, because the rootfs is still a directory moat owns.
* **the six device binds** — the runtime populates `/dev` itself, including a working `> /dev/null`.
  The whole class of traps moat carries about `mknod` being denied in a user namespace, read-only
  device binds failing with EACCES, and a swallowed bind leaving a regular file where a device
  should be, **disappears**. `AGENTS.md` invariant 1's "the only host mounts are six device nodes"
  becomes "there are no host mounts at all".
* **the namespaces** — all six differ from the host's, by inode, exactly as `moat doctor` asserts
  today. PID, mount, user, net, UTS and IPC isolation are not something a container backend has to
  re-earn.
* **"no host data"** — the host's home is not inside, and no host data is mounted.

What *does* change is smaller and named rather than guessed:

| what | why |
| --- | --- |
| **invariant 7's letter** | "No Docker, no podman, no daemon" — podman *is* a container runtime, so the invariant has to be amended the way invariant 8 was. Note the reason survives: rootless podman is **daemonless**, so "no daemon" is still true of the box |
| **the egress model** | moat's `filtered` mode is nftables inside the sandbox's own netns; a container backend gets the runtime's networking (`--network=none`, or netavark/pasta with a resolver). The allowlist, `--egress open\|isolated\|filtered`, `EGRESS_REGISTRY_HOSTS` and `ownNetns` all change shape — and `--network=none` is a *stronger* default than moat's current policy |
| **`sandbox/launcher.ts`** | the boot script — `unshare`, the mount table, the device binds, devpts, `--make-rprivate` — is replaced by the runtime's invocation. That is the seam |
| **a new host dependency** | today moat needs `unshare` and nothing else, and works on a host with no package manager. A container backend needs podman installed and configured (rootless storage, a cgroup manager). That is a real cost in the opposite direction from everything above, and it is why this should be an **option**, not a replacement |
| **the evidence** | `test/e2e-egress.sh` entirely, and the boot/mount sections of `test/e2e-extras.sh`, would need to run against the new backend; SPEC §7 and the namespace traps in `AGENTS.md` change |

### What this does to the options

**Option A (an opt-in container backend, `unshare` stays the default) is now measured as viable at
its core**, where the first version of this page had it as an unknown with a high cost. The work is
concentrated in two places — the launcher seam and the egress model — rather than spread over
snapshots, devices and persistence, and the new host dependency is exactly why it belongs behind an
opt-in flag rather than replacing the path that needs nothing.

**Option B (portable-first)** inherits all of A's work plus re-deriving every piece of evidence and
giving up the "works on a bare host" property.

**Option C (stay Linux-only)** remains measured and true for this host and for WSL2.

## 3. The four options, with their measurement status

| option | measured? |
| --- | --- |
| **A. An opt-in container backend**, `unshare` stays the default | **core measured viable** — a persistent directory rootfs, six differing namespaces, a working `/dev`, no host data, rootless and daemonless. The remaining cost is the launcher seam, the egress model, and podman as a host dependency |
| **B. Portable-first**, container/VM the default, `unshare` an expert flag | not measured as such; it is A's work plus re-deriving every capture, and it gives up running on a bare host |
| **C. Stay Linux-only** | **measured** — this repository's entire suite runs on Linux, including WSL2, with unprivileged user namespaces |
| **D. No second backend yet** | n/a — orthogonal to which runtime moat drives |

Option C is the only one whose evidence is already in hand, and that is a fact about *this host*, not
an argument that C is right: the audience question is about other people's machines. Option A is now
the interesting one, because the thing it was assumed to be unable to do — own a persistent directory
as the agent's filesystem — is the thing it turns out to do.

## 4. What to run to close the gap

**A host with a container runtime** (rootless podman is the closest analogue to moat's own model):

```bash
sudo apt-get install -y podman     # or: sudo dnf install -y podman
bash test/portability-spike.sh     # section 4 answers the --rootfs question
```

**A Mac** — moat's unshare path cannot run there at all, so the measurement has to be taken *inside*
a Linux VM, because that is the kernel moat would get:

```bash
brew install lima && limactl start --name=moat template://default
limactl shell moat -- uname -srm
limactl shell moat -- bash test/portability-spike.sh
# or containers instead of a VM:  brew install colima && colima start
```

Paste the output back and the decision has data. Until then, options A and B are **proposals with a
known cost and no measurements**, and this page says so rather than recommending one.

---

## 5. Summary

* **WSL2: measured, works** — and it is where every piece of moat's evidence was produced.
* **A rootless container backend: measured, viable at the core** (section 2), with its remaining cost
  concentrated in the launcher seam, the egress model, and one new host dependency.
* **macOS and Windows: unmeasured.** Not "unsupported": unmeasured, because a probe from this host
  would say nothing about the kernel moat would actually be given.
* **A container backend is a seam, not a switch** — but the seam is now **measured viable**: a
  container can be given a persistent, agent-writable directory rootfs, its own six namespaces, a
  working `/dev` and no host data. It breaks invariant 7's *letter* (podman is a container runtime)
  while keeping its *reason* (rootless podman is daemonless), and it costs a host dependency moat
  does not have today — which is why it is an option and not a replacement.
* **The spike is a script**, so the measurement can be taken on the machines that can take it.
