#!/usr/bin/env bash
#
# MicroVM spike (moat v1): what a KVM-backed box costs, what it gives, and what a backend would
# have to solve — measured on the host you run it on.
#
# moat isolates with namespaces, which is v0. A microVM puts the agent behind a *kernel* instead of
# behind missing namespaces, which is the actual v1 claim. Whether that is available here, what it
# costs, and whether it can keep moat's egress properties, are measurements about a host rather than
# opinions — so they are taken the same way `portability-spike.sh` takes its own.
#
# Run this on the machine you want measured and paste the output back:
#
#     bash test/microvm-spike.sh
#
# It changes nothing outside a scratch directory it removes, needs no root, and installs nothing. A
# section whose prerequisites are absent prints BLOCKED with the reason rather than guessing.
set -uo pipefail

say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
mark() { # mark <VERDICT> <what> [detail]
  printf '  %-9s %s%s\n' "$1" "$2" "${3:+ — $3}"
}

# The rootfs the box runs. Taken from moat's own image cache rather than fetched here: every
# artefact moat downloads is checked against a digest in lib/pins.ts before it is used, and a spike
# has no business adding a second download path that skips that.
ROOTFS_TARBALL=$(ls "$HOME"/.moat/cache/rootfs/alpine-*.tar.gz 2>/dev/null | head -1)
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/moat-microvm-XXXXXX")
trap 'rm -rf "$SCRATCH"' EXIT
LISTENER_PID=""

say "=================================================================="
say "moat microVM spike (v1)"
say "=================================================================="
say ""

# ---------------------------------------------------------------------------
say "== 1. the machine"
say ""
say "  uname     $(uname -srm)"
say "  distro    $( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}") || echo unknown )"
say "  uid       $(id -u)"
say ""

# ---------------------------------------------------------------------------
# KVM is the one thing this cannot work without: a microVM without hardware virtualisation is a
# slow emulator, and moat would not ship one.
say "== 2. KVM, and the runtime stack that drives it"
say ""
if [ -e /dev/kvm ]; then
  say "  /dev/kvm  $(ls -l /dev/kvm | awk '{print $1, $3":"$4}')"
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    mark MEASURED "/dev/kvm is openable by this user"
  else
    mark BLOCKED "/dev/kvm exists but this user cannot open it" "add the user to the kvm group and re-login"
  fi
else
  mark BLOCKED "/dev/kvm is absent" "no hardware virtualisation here"
fi
say ""
# `krun` is a crun build that drives libkrun; libkrunfw is the guest kernel+payload it boots. They
# are separate packages, and crun alone having `+LIBKRUN` in `crun --version` is not enough: crun
# dlopens libkrun at runtime, so a host can report the feature and still be unable to use it.
for bin in krun podman crun passt; do
  if have "$bin"; then mark MEASURED "$bin present" "$(command -v "$bin")"; else mark BLOCKED "$bin absent"; fi
done
for lib in libkrun.so libkrunfw.so; do
  found=$(ls /usr/lib/"$lib"* /usr/lib64/"$lib"* 2>/dev/null | head -1)
  if [ -n "$found" ]; then mark MEASURED "$lib present" "$(basename "$found")"; else mark BLOCKED "$lib absent"; fi
done
if have crun; then
  if crun --version 2>&1 | grep -q LIBKRUN; then
    mark MEASURED "this crun was compiled with libkrun support" "which alone is not enough — see the libkrunfw row"
  else
    mark MEASURED "this crun has no libkrun support" "the krun binary is the one that matters"
  fi
fi
say ""

if [ -z "$ROOTFS_TARBALL" ]; then
  mark BLOCKED "no cached Alpine rootfs to boot" "run 'moat up' once in any project, then this again"
  say ""
  say "Nothing further can be measured without a rootfs. Stopping."
  exit 0
fi
say "  rootfs    $(basename "$ROOTFS_TARBALL") (from moat's own image cache)"
mkdir -p "$SCRATCH/rootfs"
tar -xzf "$ROOTFS_TARBALL" -C "$SCRATCH/rootfs" 2>/dev/null
say "            extracted: $(du -sh "$SCRATCH/rootfs" 2>/dev/null | cut -f1)"
say ""

HOST_KERNEL=$(uname -r)
RUN="timeout 180 podman run --rm --runtime krun"

# ---------------------------------------------------------------------------
# The v1 claim itself: the box is behind its own kernel, not the host's.
say "== 3. does the box have its own kernel?"
say ""
if ! have krun || ! have podman || [ ! -r /dev/kvm ]; then
  mark BLOCKED "cannot boot a microVM here" "krun, podman and /dev/kvm are all required"
else
  GUEST=$($RUN --rootfs "$SCRATCH/rootfs" /bin/sh -c 'uname -r' 2>/dev/null | tail -1)
  if [ -z "$GUEST" ]; then
    mark BLOCKED "the microVM did not boot" "run it by hand to see the error"
  elif [ "$GUEST" = "$HOST_KERNEL" ]; then
    mark UNKNOWN "the box reports the host's kernel" "v$HOST_KERNEL — that is not a microVM"
  else
    mark MEASURED "the box runs its own kernel" "guest $GUEST, host $HOST_KERNEL"
  fi
fi
say ""

# ---------------------------------------------------------------------------
# What the runtime supplies instead of moat's own boot work.
say "== 4. what a microVM supplies by itself"
say ""
if [ -n "${GUEST:-}" ]; then
  DEV=$($RUN --rootfs "$SCRATCH/rootfs" /bin/sh -c '
    printf "devices: %s\n" "$([ -c /dev/null ] && echo "null is a real character device" || echo "null is NOT a character device")"
    printf "kvm-visible: %s\n" "$([ -e /dev/kvm ] && echo yes || echo no)"
    printf "rootfs-fs: %s\n" "$(awk "\$2==\"/\" {print \$3}" /proc/mounts | head -1)"
    printf "pid-count: %s\n" "$(ls /proc | grep -cE "^[0-9]+$")"
  ' 2>/dev/null)
  say "$(printf '%s\n' "$DEV" | sed 's/^/  /')"
  say ""
  # The six device binds are the only host mounts in a v0 box, and they exist because `mknod` is
  # denied in a user namespace. Here /dev is the guest's own devtmpfs, so a v1 backend binds
  # nothing from the host at all — strictly better for the invariant, not a complication of it.
  if printf '%s' "$DEV" | grep -q "null is a real character device"; then
    mark MEASURED "/dev is the guest's devtmpfs, so moat's six host device binds are not needed"
  else
    mark UNKNOWN "/dev is not the guest's devtmpfs" "the backend would have to supply one"
  fi
  printf '%s' "$DEV" | grep -q "kvm-visible: no" \
    && mark MEASURED "/dev/kvm is not exposed inside the box" \
    || mark UNKNOWN "/dev/kvm is visible inside" "nesting, and a host device the agent can see"
  # moat's whole copy-out model reads the rootfs *directory* on the host. If the rootfs were a disk
  # image, every one of those paths would need a different implementation.
  echo "written-by-the-box" > "$SCRATCH/rootfs/.spike-write" 2>/dev/null
  $RUN --rootfs "$SCRATCH/rootfs" /bin/sh -c 'echo "written-by-the-box" > /spike-proof.txt' >/dev/null 2>&1
  if [ -f "$SCRATCH/rootfs/spike-proof.txt" ]; then
    mark MEASURED "the box's writes land in the host directory" "virtiofs: moat's copy-out needs no new code path"
  else
    mark UNKNOWN "the box's writes did not appear on the host" "the rootfs may not be a plain directory"
  fi
  rm -f "$SCRATCH/rootfs/.spike-write" "$SCRATCH/rootfs/spike-proof.txt"
else
  mark BLOCKED "no box ran, so nothing to inspect"
fi
say ""

# ---------------------------------------------------------------------------
# The half that decides whether a backend is usable at all. moat maps `isolated` and `filtered` to
# the runtime's *default* network (sandbox/backend.ts), so a runtime whose default has no uplink
# leaves the agent unable to reach the model.
say "== 5. the datapath: can the box reach the network, and can it reach the host's loopback?"
say ""
if [ -n "${GUEST:-}" ]; then
  # The control comes first. "the host is unreachable from the box" is worthless unless something
  # was listening: three probes that reported a confident wrong answer are recorded in AGENTS.md.
  #
  # No `setsid` here, and the trap matters: `$!` for `setsid python3 …` is the *wrapper's* pid, which
  # exits immediately, so the first version of this left the listener running after the spike
  # finished — and a stray listener silently makes the next run's control row report UNKNOWN, which
  # is exactly how a check stops meaning anything.
  python3 -m http.server 47399 --bind 127.0.0.1 >"$SCRATCH/listener.log" 2>&1 </dev/null &
  LISTENER_PID=$!
  stop_listener() { [ -n "$LISTENER_PID" ] && kill "$LISTENER_PID" 2>/dev/null; LISTENER_PID=""; }
  trap 'stop_listener; rm -rf "$SCRATCH"' EXIT
  sleep 1
  if command -v curl >/dev/null 2>&1 && [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:47399/ 2>/dev/null)" = "200" ]; then
    mark MEASURED "control: a service on the host's loopback is listening" "127.0.0.1:47399 answers"
  else
    mark UNKNOWN "control: the host's own loopback listener did not answer" "the loopback rows below mean nothing"
  fi
  say ""

  probe='
    timeout 8 wget -q -O /dev/null http://1.1.1.1/ && echo "outbound=OK" || echo "outbound=no"
    echo "ifaces=[$(ls /sys/class/net | tr "\n" " ")]"
    echo "gateway=[$(awk "NR>1 && \$2==\"00000000\" {print \$3}" /proc/net/route)]"
    for a in 127.0.0.1 10.0.2.2 192.168.0.1; do
      timeout 4 wget -q -O /dev/null "http://$a:47399/" 2>/dev/null \
        && echo "loopback-via-$a=REACHED" || echo "loopback-via-$a=refused"
    done
  '
  say "  --- default networking (TSI: no network device is added) ---"
  say "$($RUN --rootfs "$SCRATCH/rootfs" /bin/sh -c "$probe" 2>/dev/null | sed 's/^/    /')"
  say ""
  say "  --- passt: a host-side datapath process (krun.use_passt=1) ---"
  PASST_OUT=$($RUN --annotation krun.use_passt=1 --rootfs "$SCRATCH/rootfs" /bin/sh -c "$probe" 2>/dev/null)
  say "$(printf '%s\n' "$PASST_OUT" | sed 's/^/    /')"
  say ""

  if printf '%s' "$PASST_OUT" | grep -q "outbound=OK"; then
    mark MEASURED "a passt-backed box has an uplink" "the default (TSI) networking does not, which is why moat's modes map to it"
  else
    mark BLOCKED "no uplink even with passt" "a v1 box could not reach the model"
  fi
  if printf '%s' "$PASST_OUT" | grep -q "loopback-via-[^=]*=REACHED"; then
    mark BLOCKED "the host's loopback is reachable from the box" "moat's --disable-host-loopback property does not survive to v1 as-is"
  else
    # Which address the gateway is matters: moat's doctor probes 127.0.0.1 *and* slirp's 10.0.2.2
    # because that was the hole. passt's gateway is 192.168.0.1, so a v1 doctor has to probe the
    # address this run measured rather than the one slirp uses, or it would pass on the wrong one.
    mark MEASURED "the host's loopback is not reachable from the box" "all three addresses refused; passt's gateway is not 10.0.2.2, so a v1 probe must use the address measured here"
  fi
  stop_listener
else
  mark BLOCKED "no box ran, so the datapath is unmeasured"
fi
say ""

# ---------------------------------------------------------------------------
# "boot time, image size, delta vs v0" is the row docs/VERIFICATION.md lists as unverified for v1.
say "== 6. what it costs: boot time and image size, against the v0 container path"
say ""
if [ -n "${GUEST:-}" ] && have crun; then
  timeit() { # timeit <runtime> [extra podman args...]
    local rt="$1"; shift
    local s e
    s=$(date +%s%N)
    timeout 120 podman run --rm --runtime "$rt" "$@" --rootfs "$SCRATCH/rootfs" /bin/true >/dev/null 2>&1
    e=$(date +%s%N)
    echo $(( (e - s) / 1000000 ))
  }
  # Warm both caches first, so the reading is a boot rather than a page-in.
  timeit crun >/dev/null; timeout 120 podman run --rm --runtime krun --rootfs "$SCRATCH/rootfs" /bin/true >/dev/null 2>&1
  V0=""; V1=""
  for _ in 1 2 3; do V0="$V0 $(timeit crun)"; V1="$V1 $(timeit krun)"; done
  say "  v0  (--runtime crun, the container backend): ${V0# } ms"
  say "  v1  (--runtime krun, a microVM)          : ${V1# } ms"
  say ""
  say "  rootfs (shared):  $(du -sh "$SCRATCH/rootfs" | cut -f1)"
  # Resolve the symlinks first: `ls -l` reports a link's own length, not the library's.
  for entry in "libkrun.so.1:the VMM" "libkrunfw.so.5:the guest kernel and its payload"; do
    lib="${entry%%:*}"; what="${entry#*:}"
    for dir in /usr/lib /usr/lib64; do
      [ -e "$dir/$lib" ] || continue
      say "  $lib ($what): $(stat -c%s "$(readlink -f "$dir/$lib")" | awk '{printf "%.1f MB", $1/1048576}')"
      break
    done
  done
  mark MEASURED "the cost of a kernel boundary is the delta between those two rows" "same rootfs, no image build"
else
  mark BLOCKED "cannot compare v1 against v0 here" "needs both a booting microVM and crun"
fi
say ""

# ---------------------------------------------------------------------------
say "=================================================================="
say "What this run measured, and what it did not"
say "=================================================================="
say ""
say "  measured    whether KVM is usable, the runtime stack, whether the box has its own kernel,"
say "              what the runtime supplies (/dev, rootfs sharing), whether the box has an uplink"
say "              under the default networking and under passt, whether the host's loopback is"
say "              reachable from it, and the boot cost against the v0 container path"
say "  not measured  whether a moat-owned proxy can be the datapath (libkrun can be handed a unix"
say "              socket or a passt fd, which is the design question this spike does not settle),"
say "              whether filtered's nftables allowlist has a v1 equivalent, and whether either"
say "              runtime's HTTP client honours a proxy setting — that last one decides whether a"
say "              resolving proxy can be the egress point at all"
say ""
VERSION_ID=$( (. /etc/os-release 2>/dev/null && echo "${ID:-unknown}") || echo unknown )
say "  host        $VERSION_ID, kernel $HOST_KERNEL, uid $(id -u)"
