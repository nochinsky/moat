# The v1 microVM: what is measured on a host that has KVM

moat isolates with namespaces, which is v0. The v1 claim is a **kernel** boundary: the agent runs
behind its own kernel, so a kernel bug in the agent's box is not a kernel bug on your machine. This
page records what that costs and what it needs, measured on a host where `/dev/kvm` is usable.

It is a **measurement record, not a design.** The decisions are in §5 and they are open. Every
reading here comes from `test/microvm-spike.sh`, which takes them on the machine you run it on.

A reading is a fact about a host, not about moat. These were taken on Arch Linux, kernel
`7.2.6-arch2-1`, uid 1000, podman 6.1.2, `krun` 1.29.1 (libkrun 1.19.4, libkrunfw 5.6.1), with passt
installed. `docs/VERIFICATION.md`'s v1 row is a different machine's record — the WSL2 host, where
`kvm=no` and the path was untestable. That page is not contradicted by this one; it is a different
host, and it says so.

## 1. A microVM boots moat's own rootfs, on its own kernel

The whole claim, in one reading. The rootfs is moat's cached Alpine minirootfs, extracted to a plain
directory — the same artefact and the same directory shape a v0 box gets:

```
$ podman run --rm --runtime krun --rootfs <moat's alpine dir> /bin/sh -c 'uname -r'
6.12.109          # guest kernel, from libkrunfw
$ uname -r
7.2.6-arch2-1     # host
```

Two different kernels. `krun` is a crun build that drives libkrun, and **the stack is more than one
package**: `crun` on this host reports `+LIBKRUN` in `crun --version`, which is *not* enough — it
dlopens libkrun at runtime, so a host can report the feature and still have no microVM. What is
needed is `krun` plus `libkrun` (the VMM) plus `libkrunfw` (**the guest kernel and its payload**).

## 2. What comes with it, rather than having to be built

* **`/dev` is the guest's `devtmpfs`.** `/dev/null` is a real character device, `hvc0-7` and `vsock`
  are there, and `/dev/kvm` is **not** exposed inside. So a v1 box binds *nothing* from the host:
  moat's six device binds exist only because `mknod` is denied in a user namespace, and a guest
  kernel has no such restriction. Invariant 1 gets *stronger* here, not more complicated.
* **The rootfs is `virtiofs`, and the box's writes land in the host directory immediately** — a file
  written inside appeared at its host path with identical content. moat's entire copy-out, diff,
  three-way merge and per-hunk review read that directory, so none of it needs a new code path. A
  backend over a disk image would have needed all of it.
* **`/proc` shows the guest's own processes** — a few hundred pids, because a guest kernel has its
  own threads. That is what "own kernel" looks like from inside, and it is a further check on §1.

## 3. What it costs

`/bin/true`, warm, three runs each, same rootfs directory:

| | boot | rootfs | runtime weight |
| --- | --- | --- | --- |
| v0 (`--runtime crun`, the container backend) | 175–176 ms | 7.8 MB | already installed |
| v1 (`--runtime krun`, a microVM) | 574–607 ms | 7.8 MB, the same directory | +5.6 MB libkrun +22.8 MB libkrunfw |

(One run's three readings each, from the spike: `176 175 176` against `594 607 574`.)

So a kernel boundary costs roughly **400 ms of boot and ~28 MB of runtime**, with no image build and
no change to the rootfs. "boot time, image size, delta vs v0" is the row `docs/VERIFICATION.md`
lists as unverified for v1; these are those three readings, on this host.

## 4. The hard part is the datapath, not the microVM

This is the finding that shapes the work. moat maps `isolated` and `filtered` to **the runtime's
default network** (`sandbox/backend.ts`), deliberately. Under a microVM that default is TSI, and TSI
gives the guest no NIC at all:

```
--- default networking (TSI: no network device is added) ---
  outbound=no
  ifaces=[dummy0 lo ]
  gateway=[]
--- passt: a host-side datapath process (krun.use_passt=1) ---
  outbound=OK
  ifaces=[dummy0 eth0 lo ]
  gateway=[0101A8C0]        # 192.168.0.1
```

A passt-backed box has an uplink, and the host's loopback stays closed — a control confirmed a
service *was* listening on `127.0.0.1`, and the box could not reach it through `127.0.0.1`,
`10.0.2.2` or the gateway. That is the analogue of the property `slirp4netns --disable-host-loopback`
buys today, measured rather than assumed.

Two consequences worth keeping:

* **`moat doctor`'s dual loopback probe would need a v1 address.** It probes `127.0.0.1` *and*
  `10.0.2.2` because slirp's gateway was the hole. passt's gateway is `192.168.0.1`, so a probe that
  kept testing `10.0.2.2` would pass on an address nothing is listening on.
* **passt is to a microVM what slirp4netns is to the unshare backend** — a host-side userspace
  datapath moat could spawn, control, and pin in `lib/pins.ts`. libkrun exposes the seam for that
  rather than hiding it: `krun_add_net_unixstream` attaches a guest NIC to a host unix socket your
  own process listens on, and `krun_set_passt_fd` hands libkrun a datapath process you started.

## 5. What is not measured, and what is genuinely open

* **Whether a moat-owned proxy can be the egress point — measured, and it can.** The proxy that
  would close the egress second half (name-based allowlist, per-host ports, no DNS channel) has to
  be *used* by the agent's HTTP client, and both runtimes do use one: with the standard variables
  set in the box, Codex's model request and Claude's both arrive at a recording proxy and not at the
  configured endpoint, each leg with a no-proxy control. `docs/EGRESS.md` §1 has the readings and
  `test/proxy-spike.sh` takes them. Where such a proxy can live is measured too: an isolated box
  refuses the host's loopback but *does* reach the host's non-loopback address, so a host-side proxy
  is viable there while the loopback stays closed — `docs/EGRESS.md` §4. What is open under a
  microVM is the datapath itself (§4 above).
* **Whether `filtered`'s nftables allowlist has a v1 equivalent.** A v0 box owns its netns, which is
  why `nft` works there and why SPEC §7.3 calls the filter a policy rather than a jail. A guest
  kernel's netns is not a host netns, and whether the same ruleset means anything in a VM is
  unmeasured.
* **Boot time on hosts other than this one.** The numbers in §3 are this machine's; a host without
  KVM's hardware extensions, or one under load, will differ.
* **Invariant 6 would need amending, in writing.** It says "there is no server in the box and
  nothing is proxied". The box still has no server, but a moat-owned egress point would terminate
  traffic on the host. Invariants 7 and 8 were each unlocked by a named phase; this needs the same
  treatment or the contract stops meaning anything. This page does not do that, and nothing in
  §1–§4 requires it yet.
* **What a v1 backend would *not* change:** the default stays `unshare`. Invariant 7's reason — moat
  never *requires* a container runtime, and the default runs on a bare host — survives a VM backend
  exactly as it survives the container one.

## 6. Reproducing this

```bash
bash test/microvm-spike.sh
```

It needs no root, installs nothing, takes its rootfs from moat's own image cache (a spike has no
business adding a download path that skips `lib/pins.ts`'s digests), changes nothing outside a
scratch directory it removes, and prints `MEASURED`/`BLOCKED`/`UNKNOWN` per assertion — so a host
that cannot take a reading says so instead of guessing. With no `/dev/kvm` or no `krun`, §1–§4 print
`BLOCKED` with the reason.
