#!/usr/bin/env bash
#
# Portability spike: what this host can and cannot do, and what a container or VM backend would
# have to provide.
#
# moat isolates with `unshare` + `mount` + `chroot` and needs no container runtime (AGENTS.md
# invariant 7). Whether that can be relaxed is a *measurement* about a host, not an opinion, and it
# has to be taken on the hosts that matter: a plain Linux box, a hardened one, WSL2, and a Mac.
#
# Run this on the machine you want measured and paste the output back:
#
#     bash test/portability-spike.sh
#
# It changes nothing outside a scratch directory it removes. Every probe is read-only; the two
# probes that would need a privileged container runtime are skipped and *named* as skipped rather
# than guessed at.
set -uo pipefail

say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
mark() { # mark <VERDICT> <what> [detail]
  printf '  %-9s %s%s\n' "$1" "$2" "${3:+ — $3}"
}

say "=================================================================="
say "moat portability spike"
say "=================================================================="
say ""

# ---------------------------------------------------------------------------
say "== 1. the machine"
say ""
say "  uname     $(uname -srm)"
say "  kernel    $(head -c 90 /proc/version 2>/dev/null || echo unknown)"
if grep -qi microsoft /proc/version 2>/dev/null; then
  say "  platform  WSL2 (a Linux kernel under Windows)"
elif [ "$(uname -s)" = "Darwin" ]; then
  say "  platform  macOS $(sw_vers -productVersion 2>/dev/null || echo unknown)"
else
  say "  platform  native Linux"
fi
say "  distro    $( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}") || echo unknown )"
say "  uid       $(id -u)"
say "  cgroup    $( [ -f /sys/fs/cgroup/cgroup.controllers ] && echo cgroup-v2 || echo "cgroup-v1 or unknown" )"
say ""

# ---------------------------------------------------------------------------
# The one kernel feature moat cannot work without. Everything else here is about relaxing a
# constraint, but this one is the constraint.
say "== 2. unprivileged user namespaces — the feature moat cannot work without"
say ""
say "  max_user_namespaces: $(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 'n/a')"
say "  apparmor_restrict_unprivileged_userns: $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 'absent')"
say ""
say "  probe: unshare --user --map-root-user --mount sh -c 'mount -t tmpfs none <scratch>'"
if have unshare; then
  # The mount point has to exist *before* the mount, and it has to be created on the host: inside
  # the new namespace every path is still the host's until something is mounted over it. The first
  # version of this probe mounted onto `/tmp/.moat-spike`, which does not exist, and reported
  # BLOCKED for a host whose sandbox suites all pass — a false negative produced by the probe
  # rather than by the kernel.
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/moat-spike-XXXXXX")"
  out=$(unshare --user --map-root-user --mount sh -c "mount -t tmpfs none '$scratch' && echo PROBE_OK" 2>&1 | tail -2)
  rmdir "$scratch" 2>/dev/null || true
  case "$out" in
    *PROBE_OK*) mark MEASURED "user namespaces work" "unshare, and a mount inside them, succeeded" ;;
    *) mark BLOCKED "user namespaces do not work here" "$(printf '%s' "$out" | tr '\n' ' ' | head -c 160)" ;;
  esac
else
  mark UNKNOWN "unshare is not installed" "no /usr/bin/unshare"
fi
say ""

# ---------------------------------------------------------------------------
say "== 3. container runtimes present"
say ""
FOUND_CTR=""
for c in podman docker nerdctl lxc incus systemd-nspawn; do
  if have "$c"; then
    mark FOUND "$c" "$(command -v "$c")"
    [ -z "$FOUND_CTR" ] && FOUND_CTR="$c"
  else
    mark absent "$c"
  fi
done
say ""

# ---------------------------------------------------------------------------
# The question a container backend has to answer is not "does it run" but "can it give moat the
# four properties the unshare path gives": root inside, its own PID namespace and /dev, no host data
# mounted, and a *persistent, agent-writable directory* as the root filesystem — which is the one a
# container image cannot give, because moat's rootfs survives between boots and the agent owns it.
say "== 4. does a container runtime give what moat needs?"
say ""
if [ -z "$FOUND_CTR" ]; then
  mark SKIPPED "no container runtime installed" "nothing to measure — this is the reading that has to be taken on the host that has one"
  say ""
  say "  To take it, install one (rootless podman is the closest analogue) and re-run:"
  say "    Debian/Ubuntu:  sudo apt-get install -y podman"
  say "    Fedora:         sudo dnf install -y podman"
  say "  then:           bash test/portability-spike.sh"
elif [ "$FOUND_CTR" = "podman" ] || [ "$FOUND_CTR" = "docker" ]; then
  if $FOUND_CTR info >/dev/null 2>&1; then
    mark MEASURED "$FOUND_CTR is usable by this user" "rootless, no sudo"
    if $FOUND_CTR run --rm --rootfs /tmp alpine true >/dev/null 2>&1; then
      mark MEASURED "--rootfs accepts a plain directory" "a persistent rootfs is possible"
    else
      mark UNKNOWN "--rootfs could not be tested (no image, or not supported)" "try: $FOUND_CTR run --rm --rootfs /tmp sh -c true"
    fi
    mark NOT-MEASURED "whether a container rootfs survives between boots" "moat's rootfs is persistent and agent-writable; a container image is not"
  else
    mark BLOCKED "$FOUND_CTR is installed but unusable by this user" "likely root-only; try rootless setup, or run as root"
  fi
else
  mark UNKNOWN "$FOUND_CTR is present" "not a runtime this spike knows how to probe"
fi
say ""

# ---------------------------------------------------------------------------
say "== 5. the microVM path (moat v1)"
say ""
if [ -e /dev/kvm ]; then
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    mark MEASURED "/dev/kvm is accessible" "$(stat -c '%A %U:%G' /dev/kvm 2>/dev/null)"
  else
    mark BLOCKED "/dev/kvm exists but this user cannot open it" "$(stat -c '%A %U:%G' /dev/kvm 2>/dev/null) — moat doctor reports the same"
  fi
else
  mark absent "/dev/kvm" "no hardware virtualisation exposed to this kernel"
fi
say ""

# ---------------------------------------------------------------------------
say "== 6. macOS, if that is where you are"
say ""
if [ "$(uname -s)" = "Darwin" ]; then
  mark MEASURED "this is a Mac" "moat's unshare path cannot run here at all: no Linux namespaces"
  say ""
  say "  A Mac needs a Linux VM in front of moat. The two candidates worth measuring:"
  say "    brew install lima && limactl start --name=moat template://default"
  say "    limactl shell moat -- uname -srm          # a Linux kernel, reached from macOS"
  say "    limactl shell moat -- bash test/portability-spike.sh"
  say "  or, for containers instead of a VM:  brew install colima && colima start"
  say ""
  say "  What to bring back: the output of the probe above *inside* the VM, because that is the"
  say "  kernel moat would actually get. A macOS host's own facts say nothing about it."
else
  mark "n/a" "not macOS" "this branch is here for whoever runs it on a Mac"
fi
say ""

# ---------------------------------------------------------------------------
say "=================================================================="
say "What this run measured, and what it did not"
say "=================================================================="
say ""
say "  measured    the platform line above, user-namespace availability, which container"
say "              runtimes exist, and whether /dev/kvm is reachable"
say "  not measured anything marked SKIPPED or UNKNOWN — and, always, whether moat's own"
say "              sandbox suites pass on this host: that is"
say "                bash test/e2e-codex.sh"
say "              which needs the feature in section 2 and several hundred MB of downloads."
say ""
