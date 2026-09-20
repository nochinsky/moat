#!/usr/bin/env bash
#
# Egress policy verification: a sandbox in its own network namespace keeps
# outbound access through the pinned slirp4netns datapath and loses the host's
# network position, including the host's loopback and slirp's 10.0.2.2 gateway.
#
# No API key is needed. Reachability is proven by the provider answering 401 to
# an unauthenticated request, which a local stub on the host's loopback cannot
# fake from inside an isolated namespace.
#
# Usage: bash test/e2e-egress.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
M="node $REPO/cmd/main.ts"
EVIDENCE="$REPO/test/evidence"
PROJECT="$HOME/moat-demo/egress-project"
LOG="$EVIDENCE/egress.txt"
HOSTPORT=47311
FAIL=0
LISTENER=""

mkdir -p "$EVIDENCE"
: > "$LOG"

scrub() { sed -e "s|$HOME|/home/user|g" -e "s|$(id -un)|user|g"; }
say() { echo "$@" | tee -a "$LOG"; }
capture() {
  local name="$1"; shift
  {
    echo ""
    echo "--- \$ $*"
    "$@" > "$EVIDENCE/$name.out" 2> "$EVIDENCE/$name.err"
    echo "--- exit $?"
    echo "--- stdout ---"; cat "$EVIDENCE/$name.out"
    echo "--- stderr ---"; cat "$EVIDENCE/$name.err"
  } | scrub > "$EVIDENCE/$name.txt"
  cat "$EVIDENCE/$name.txt" | tee -a "$LOG"
}
check() {
  if grep -q "$2" "$3"; then say "  pass  $1"; else say "  FAIL  $1"; FAIL=1; fi
}
check_absent() {
  if grep -q "$2" "$3"; then say "  FAIL  $1"; FAIL=1; else say "  pass  $1"; fi
}
# The teardown check is about *this* environment's datapath. A machine-wide
# `pgrep -f slirp4netns` also finds other environments' processes, so the suite
# failed whenever any other sandbox happened to be up. Read the pid this box
# recorded, then assert that pid is gone.
env_slirp_pid() {
  python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('slirpPid') or '')" \
    "$EVIDENCE/status-before-down.out" 2>/dev/null
}
slirp_gone() {
  [ -z "$1" ] && return 0
  ! kill -0 "$1" 2>/dev/null
}

say "=============================================================="
say "== egress policy: an isolated network namespace"
say "=============================================================="
say "the sandbox gets its own netns and the pinned slirp4netns datapath; the host"
say "reaches opencode through an explicit port forward, and the host's loopback is"
say "closed on both routes (127.0.0.1 inside the namespace and slirp's 10.0.2.2)."

# A host service on loopback, reachable only if the gateway is left open.
python3 -m http.server "$HOSTPORT" --bind 127.0.0.1 >/dev/null 2>&1 &
LISTENER=$!
trap 'kill $LISTENER 2>/dev/null' EXIT

rm -rf "$PROJECT"
mkdir -p "$PROJECT"
cd "$PROJECT"
git init -q -b main
git config user.email egress@example.com
git config user.name "Egress Test"
echo "# egress" > README.md
git add -A
git commit -qm "egress fixture"

say ""
say "--- boot isolated ---"
capture up $M up --runtime opencode --egress isolated
check "the box booted with isolated egress" "sandbox up" "$EVIDENCE/up.txt"

capture status $M status
check "status reports running"            "status       running"  "$EVIDENCE/status.txt"
check "status reports isolated egress"    "egress       isolated" "$EVIDENCE/status.txt"

say ""
say "--- the host reaches the sandbox server only through slirp's forward ---"
capture env $M env --json
URL=$(python3 -c "import json;print(json.load(open('$EVIDENCE/env.out'))['url'])")
PASSWORD=$(python3 -c "import json;print(json.load(open('$EVIDENCE/env.out'))['password'])")
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -u "opencode:$PASSWORD" "$URL/config")
say "  GET $URL/config with basic auth -> HTTP $CODE"
if [ "$CODE" = "200" ]; then say "  pass  the port forward works"; else say "  FAIL  the port forward works ($CODE)"; FAIL=1; fi

say ""
say "--- outbound still works, the host's loopback does not ---"
capture egress-provider $M exec -- /bin/sh -c 'curl -sS -o /dev/null -w "%{http_code}" --max-time 20 https://api.deepseek.com/models'
check "the provider answers through slirp (401 without a key)" "401" "$EVIDENCE/egress-provider.txt"

capture egress-gateway $M exec -- /bin/sh -c "curl -sS --max-time 6 -o /dev/null http://10.0.2.2:$HOSTPORT; echo gateway-exit=\$?"
check_absent "slirp's 10.0.2.2 gateway cannot reach the host's loopback" "gateway-exit=0" "$EVIDENCE/egress-gateway.txt"

capture doctor $M doctor
check "doctor reports the isolated namespace"        "pass  network namespace isolated" "$EVIDENCE/doctor.txt"
check "doctor reports loopback unreachable"          "pass  host loopback reachable"    "$EVIDENCE/doctor.txt"
check_absent "doctor no longer says the namespace is shared" "network namespace shared" "$EVIDENCE/doctor.txt"

say ""
say "--- restart filtered: a default-deny allowlist inside the namespace ---"
capture status-before-down $M status --json
ISOLATED_SLIRP=$(env_slirp_pid)
capture down-isolated $M down
sleep 1
if slirp_gone "$ISOLATED_SLIRP"; then
  say "  pass  the isolated box's slirp (pid ${ISOLATED_SLIRP:-none}) stopped with it"
else
  say "  FAIL  the isolated box's slirp (pid $ISOLATED_SLIRP) outlived it"
  FAIL=1
fi

capture up-filtered $M up --runtime opencode --egress filtered
check "the box booted with filtered egress" "sandbox up" "$EVIDENCE/up-filtered.txt"

capture status-filtered $M status
check "status reports filtered egress" "egress       filtered" "$EVIDENCE/status-filtered.txt"

capture egress-allowed $M exec -- /bin/sh -c 'curl -sS -o /dev/null -w "%{http_code}" --max-time 25 https://api.deepseek.com/models'
check "the allowlisted provider is still reachable (401 without a key)" "401" "$EVIDENCE/egress-allowed.txt"

capture egress-blocked $M exec -- /bin/sh -c 'curl -sS --max-time 6 -o /dev/null -w "code %{http_code}\n" https://1.1.1.1/ ; echo "curl-exit=$?"'
check "the blocked probe ran inside the box"           "curl-exit=" "$EVIDENCE/egress-blocked.txt"
check_absent "an address outside the allowlist is refused" "curl-exit=0" "$EVIDENCE/egress-blocked.txt"

capture doctor-filtered $M doctor
check "doctor reports filtered egress"              "pass  egress filtered" "$EVIDENCE/doctor-filtered.txt"
check_absent "doctor no longer calls egress unrestricted" "egress unrestricted" "$EVIDENCE/doctor-filtered.txt"

say ""
say "--- a filtered environment whose nft binary is gone reinstalls it before booting ---"
say "the image carries nft, but a rootfs restored from a snapshot taken before it did,"
say "or one whose agent removed it, would otherwise fail every boot with a message"
say "that reads like a moat bug."
capture status-json-filtered $M status --json
ENVDIR_F=$(python3 -c "import json;print(json.load(open('$EVIDENCE/status-json-filtered.out'))['envDir'])" 2>/dev/null)
if [ -n "$ENVDIR_F" ] && [ -f "$ENVDIR_F/rootfs/usr/sbin/nft" ]; then
  rm -f "$ENVDIR_F/rootfs/usr/sbin/nft"
  say "  (removed the binary from $ENVDIR_F/rootfs/usr/sbin/nft)"
  capture nft-reinstall $M exec -- /bin/sh -c 'command -v nft; curl -sS --max-time 6 -o /dev/null -w "code %{http_code}\n" https://1.1.1.1/ ; echo "curl-exit=$?"'
  check "nft was reinstalled before the filtered boot" "/usr/sbin/nft" "$EVIDENCE/nft-reinstall.txt"
  check "the reinstalled box ran the probe" "curl-exit=" "$EVIDENCE/nft-reinstall.txt"
  check_absent "and it is still filtered" "curl-exit=0" "$EVIDENCE/nft-reinstall.txt"
else
  say "  FAIL  no nft binary to remove at $ENVDIR_F/rootfs/usr/sbin/nft"
  FAIL=1
fi

say ""
say "--- a measured limit, recorded rather than asserted: root in the box can drop its own filter ---"
say "the ruleset lives in the sandbox's own network namespace and the agent is root"
say "there, so it holds CAP_NET_ADMIN and can flush it. That is inherent to running"
say "the filter where the agent works; the policy bounds where the box talks during"
say "normal work, it is not a jail for a hostile agent. moat doctor re-measures the"
say "filter on every run."
capture flush-limit $M exec -- /bin/sh -c 'nft list chain inet moat_egress output >/dev/null 2>&1; echo "filter-present-exit=$?"; nft flush ruleset; echo "flush-exit=$?"; sleep 0.3; curl -sS --max-time 6 -o /dev/null -w "http %{http_code}\n" https://1.1.1.1/ ; echo "curl-exit=$?"'

say ""
say "--- teardown: the filtered box ---"
capture status-before-down-filtered $M status --json
FILTERED_SLIRP=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('slirpPid') or '')" \
  "$EVIDENCE/status-before-down-filtered.out" 2>/dev/null)
capture down-filtered $M down
sleep 1
if slirp_gone "$FILTERED_SLIRP"; then
  say "  pass  the filtered box's slirp (pid ${FILTERED_SLIRP:-none}) stopped with it"
else
  say "  FAIL  the filtered box's slirp (pid $FILTERED_SLIRP) outlived it"
  FAIL=1
fi
capture destroy $M destroy --yes

say ""
say "--- a fresh project with no --egress flag: the default policy ---"
say "an environment with no recorded mode takes the default. It has to be the"
say "filtered policy, and it has to be enforced, not merely reported."
DEFAULT_PROJECT="$HOME/moat-demo/egress-default"
rm -rf "$DEFAULT_PROJECT"
mkdir -p "$DEFAULT_PROJECT"
cd "$DEFAULT_PROJECT"
git init -q -b main
git config user.email egress@example.com
git config user.name "Egress Test"
echo "# default" > README.md
git add -A
git commit -qm "default fixture"

capture up-default $M up --runtime opencode
check "a fresh environment boots filtered by default" "sandbox up" "$EVIDENCE/up-default.txt"
capture status-default $M status
check "the default policy is reported as filtered" "egress       filtered" "$EVIDENCE/status-default.txt"

capture default-allowed $M exec -- /bin/sh -c 'curl -sS -o /dev/null -w "%{http_code}" --max-time 25 https://api.deepseek.com/models'
check "the default policy still allows the provider (401 without a key)" "401" "$EVIDENCE/default-allowed.txt"

capture default-blocked $M exec -- /bin/sh -c 'curl -sS --max-time 6 -o /dev/null -w "code %{http_code}\n" https://1.1.1.1/ ; echo "curl-exit=$?"'
check "the default-policy probe ran inside the box"  "curl-exit=" "$EVIDENCE/default-blocked.txt"
check_absent "the default policy blocks an address outside the allowlist" "curl-exit=0" "$EVIDENCE/default-blocked.txt"

capture down-default $M down
capture destroy-default $M destroy --yes

say ""
say "--- a filtered boot refuses to start when the provider does not resolve ---"
say "the allowlist is built from the provider host. If that name resolves to"
say "nothing, a boot would leave a box with no way to reach the model; it fails"
say "instead, naming the host and the way out."
capture up-nxdomain $M up --runtime opencode --base-url "https://nxdomain-$RANDOM.invalid/v1"
check "an unresolvable provider fails the boot" "could not resolve" "$EVIDENCE/up-nxdomain.txt"
capture destroy-nxdomain $M destroy --yes

say ""
say "egress checks $( [ "$FAIL" = "0" ] && echo passed || echo FAILED )"
exit "$FAIL"
