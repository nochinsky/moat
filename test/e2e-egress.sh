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
capture up $M up --egress isolated
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
check "doctor reports the isolated namespace"        "network namespace isolated" "$EVIDENCE/doctor.txt"
check "doctor reports loopback unreachable"          "host loopback reachable"    "$EVIDENCE/doctor.txt"
check_absent "doctor no longer says the namespace is shared" "network namespace shared" "$EVIDENCE/doctor.txt"

say ""
say "--- teardown ---"
capture down $M down
sleep 1
if pgrep -f slirp4netns >/dev/null 2>&1; then
  say "  FAIL  slirp stopped with the box"
  FAIL=1
else
  say "  pass  slirp stopped with the box"
fi
capture destroy $M destroy --yes

say ""
say "egress checks $( [ "$FAIL" = "0" ] && echo passed || echo FAILED )"
exit "$FAIL"
