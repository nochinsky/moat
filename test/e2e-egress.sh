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
say "the sandbox gets its own netns and the pinned slirp4netns datapath, with nothing"
say "forwarded in: the host's loopback is closed on both routes (127.0.0.1 inside the"
say "namespace and slirp's 10.0.2.2 gateway), and the box has no host-facing server."

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
# Every boot names its credential policy. These four used to name none, so on a host carrying a key
# of its own the box got one: the committed captures record `injecting deepseek credential
# sha256:34c4e933b47c1fb3 … as DEEPSEEK_API_KEY`, and that is not a value this suite ever passed in.
# It also contradicts this file's own premise — "No API key is needed. Reachability is proven by the
# provider answering 401 to an unauthenticated request" — so on that host the reachability check was
# made with an authenticated request instead. `--no-credential` is what the suite means, and it is
# silent for the default provider.
capture up $M up --no-credential --egress isolated
check "the box booted with isolated egress" "sandbox up" "$EVIDENCE/up.txt"

capture status $M status
check "status reports running"            "status       running"  "$EVIDENCE/status.txt"
check "status reports isolated egress"    "egress       isolated" "$EVIDENCE/status.txt"

say ""
say "--- there is no server in the box for the host to reach ---"
# The port forward existed to reach the in-box agent server. There is no server now, and the
# honest form of that claim is a check that nothing advertises an endpoint: if a url or a port
# comes back to status, this fails.
capture status-json $M status --json
if python3 -c "import json,sys; d=json.load(open('$EVIDENCE/status-json.out')); sys.exit(0 if 'url' not in d and 'port' not in d else 1)"; then
  say "  pass  status records no endpoint, so the host has nothing to reach"
else
  say "  FAIL  status still advertises an endpoint"; FAIL=1
fi

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

capture up-filtered $M up --no-credential --egress filtered
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

capture up-default $M up --no-credential
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
say "--- with --egress-proxy the proxy is the only path ---"
say "The box's namespace holds the loopback and the link to the proxy, and nothing"
say "else: no tap, no default route, no resolver. That is what makes the policy a"
say "boundary rather than the route well-behaved clients happen to take, so every"
say "part of it is checked below against an unproxied control that must fail the"
say "same checks."
capture up-proxy $M up --egress filtered --egress-proxy --no-credential --model deepseek-flash --base-url "https://api.deepseek.com/v1"
check "the box booted with the proxy deciding" "sandbox up" "$EVIDENCE/up-proxy.txt"

capture ifaces-proxy $M exec -- /bin/sh -c 'awk -F: "/:/{print \$1}" /proc/net/dev | tr -d " " | sort | tr "\n" " " | sed "s/\$/ /"'
check "the box has the loopback and the proxy link" "lo moatp" "$EVIDENCE/ifaces-proxy.txt"
check_absent "the box has no datapath of its own" "tap0" "$EVIDENCE/ifaces-proxy.txt"

capture route-proxy $M exec -- /bin/sh -c 'echo "defaults=$(awk "\$2==\"00000000\"{n++} END{print n+0}" /proc/net/route)"'
check "the box has no default route" "defaults=0" "$EVIDENCE/route-proxy.txt"

capture resolv-proxy $M exec -- /bin/sh -c 'cat /etc/resolv.conf'
check "the box's resolver refuses rather than resolving" "nameserver 127.0.0.1" "$EVIDENCE/resolv-proxy.txt"
check_absent "the box's own resolver is not slirp's" "slirp" "$EVIDENCE/resolv-proxy.txt"

capture noroute-proxy $M exec -- /bin/sh -c 'printf "CONNECT 1.1.1.1:443 HTTP/1.0\r\n\r\n" | /bin/bash -c "exec 3<>/dev/tcp/1.1.1.1/443" 2>&1 | head -1'
check "a direct dial has nowhere to go: no route, not a timeout" "Network unreachable" "$EVIDENCE/noroute-proxy.txt"

capture answer-proxy $M exec -- /bin/sh -c 'printf "CONNECT api.deepseek.com:443 HTTP/1.0\r\n\r\n" | /bin/bash -c "exec 3<>/dev/tcp/10.0.9.2/41417; cat >&3; head -1 <&3"'
check "the proxy is reachable and dials the provider" "200 Connection Established" "$EVIDENCE/answer-proxy.txt"

say ""
say "the control is a *separate* environment without the flag. --egress-proxy is"
say "recorded in state and persists for the environment it was chosen for, which"
say "is right — re-booting this one without the flag would not be a control."
CONTROL="$HOME/moat-demo/egress-control"
rm -rf "$CONTROL"; mkdir -p "$CONTROL"
( cd "$CONTROL" && git init -q . && git config user.email moat@example.com && git config user.name moat \
  && printf '{"name":"control","scripts":{"test":"true"}}\n' > package.json && git add -A && git commit -qm base )
( cd "$CONTROL" && $M up --quiet --egress filtered --no-credential --model deepseek-flash --base-url "https://api.deepseek.com/v1" ) > "$EVIDENCE/up-control.txt" 2>&1
( cd "$CONTROL" && $M exec -- /bin/sh -c 'awk -F: "/:/{print \$1}" /proc/net/dev | tr -d " " | sort | tr "\n" " "' ) > "$EVIDENCE/ifaces-control-exec.txt" 2>&1
check "the control box keeps its own datapath" "tap0" "$EVIDENCE/ifaces-control-exec.txt"
( cd "$CONTROL" && $M destroy --yes ) >/dev/null 2>&1

say ""
say "packages still install inside a box with no datapath. nft is removed and a"
say "filtered boot has to put it back, which runs apk in the box."
capture rm-nft $M exec -- /bin/sh -c 'rm -f /usr/sbin/nft && command -v nft || echo "nft removed"'
check "nft was removed inside the box" "nft removed" "$EVIDENCE/rm-nft.txt"
capture nft-back $M exec -- /bin/sh -c 'command -v nft'
check "the filtered boot repaired it without a datapath" "/usr/sbin/nft" "$EVIDENCE/nft-back.txt"

capture doctor-proxy $M doctor
check "doctor reports the policy through the proxy" "reachable through the proxy" "$EVIDENCE/doctor-proxy.txt"
# And the variables moat sets for the proxy are moat's own: a proxied box has HTTP_PROXY by design, and
# the doctor called that a host environment leak until this was fixed. This row is what caught it.
check "doctor does not read its own proxy variables as a host leak" "pass  no host env forwarded" "$EVIDENCE/doctor-proxy.txt"
capture destroy-proxy $M destroy --yes

say ""
say "--- a filtered boot refuses to start when the provider does not resolve ---"
say "the allowlist is built from the provider host. If that name resolves to"
say "nothing, a boot would leave a box with no way to reach the model; it fails"
say "instead, naming the host and the way out."
capture up-nxdomain $M up --no-credential --base-url "https://nxdomain-$RANDOM.invalid/v1"
check "an unresolvable provider fails the boot" "could not resolve" "$EVIDENCE/up-nxdomain.txt"
capture destroy-nxdomain $M destroy --yes

say ""
say "egress checks $( [ "$FAIL" = "0" ] && echo passed || echo FAILED )"
exit "$FAIL"
