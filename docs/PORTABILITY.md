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

**Nothing else is measured here**, because the host cannot measure it: no container runtime is
installed, installing one needs root this account does not have (`sudo -n` requires interactive
authentication), and macOS is a different OS with no Linux namespaces at all.

The spike's own first version reported `BLOCKED — user namespaces do not work here`, which was a
false negative produced by the probe mounting onto a path that did not exist inside the namespace,
not by the kernel. Found because the claim contradicted a suite that passes; the fix is in the
script, and the lesson is the one this repository keeps relearning — a probe that cannot succeed and
a probe that cannot fail look identical until you check them against something already known.

---

## 2. What a container backend would cost — static, from this tree

The unshare path and a container runtime differ on one axis that matters more than the rest:

> **moat's rootfs is a persistent, agent-writable directory.** Everything else follows from that.

| what moat relies on | what a container runtime offers | what has to change |
| --- | --- | --- |
| `rootfs/` is a directory the agent owns and that survives between boots | an image plus a writable layer | snapshots (`tar` of the rootfs), the image cache key, `installRuntimeBinary` writing into it, `.moat/entry.sh` — all assume a directory. `--rootfs` is the only reading that preserves it, and it is not universal |
| `unshare --user --mount --pid`, then `chroot` (`sandbox/launcher.ts`) | the runtime's own isolation | the boot script — the mount table, the six device binds, devpts, `--make-rprivate` — is replaced wholesale |
| slirp4netns + `nftables` inside the box's netns (§7.3) | `--network none` / `host` / a CNI | the whole egress model: `--egress open|isolated|filtered`, `EGRESS_REGISTRY_HOSTS`, `ownNetns`, `moat doctor`'s egress probes |
| root inside the box | runtime-dependent (rootless maps one uid) | the rootfs-write guard's premise — "the agent is root and can plant a symlink where a directory was" — has to be re-derived, not assumed |
| **no daemon** (invariant 7) | a daemon or a socket | **breaks by definition.** Amending it is a deliberate change, the way invariant 8 was amended by name in Phase 1 |
| no host filesystem mounted; six device nodes, printed by `doctor` | the runtime decides | `doctor`'s mount-table assertion, and the traps describing device binds and devpts |

Affected code and evidence: `sandbox/launcher.ts` and its unit tests, `sandbox/rootfs.ts`
(provisioning, image cache, snapshots), the whole of `test/e2e-egress.sh`, most of
`test/e2e-extras.sh`, `docs/SPEC.md` §7, and `AGENTS.md` invariant 7 plus the namespace traps.

**The honest estimate: this is a backend seam, not a flag** — a `Backend` interface with two
implementations (`unshare`, container/VM) and re-derived evidence, not a `--backend` switch over the
existing code.

---

## 3. The four options, with their measurement status

| option | measured? |
| --- | --- |
| **A. An opt-in portable backend**, unshare stays the default | **not measured** — needs a host with a container runtime (`podman`); the spike measures whether `--rootfs` accepts a plain directory, which is the load-bearing question |
| **B. Portable-first**, container/VM the default, unshare an expert flag | not measured; its cost is A's plus changing every default and every piece of evidence |
| **C. Stay Linux-only** | **measured** — this repository's entire suite runs on Linux, including WSL2, with unprivileged user namespaces |
| **D. No second backend yet** | n/a — orthogonal to which runtime moat drives |

Option C is the only one with the evidence already in hand, and that is a fact about *this host*, not
an argument that C is right: the audience question is about other people's machines.

---

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
* **macOS and Windows: unmeasured.** Not "unsupported": unmeasured, because a probe from this host
  would say nothing about the kernel moat would actually be given.
* **A container backend is a seam, not a switch**, and it breaks invariant 7 by definition; the cost
  above is the shape of the work, not a schedule.
* **The spike is a script**, so the measurement can be taken on the machines that can take it.
