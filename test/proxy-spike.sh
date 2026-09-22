#!/usr/bin/env bash
#
# Egress spike: does a runtime's model traffic actually go through a proxy when the box is told to
# use one?
#
# This is the reading a moat-owned egress proxy stands or falls on. moat's egress policy today is an
# nftables allowlist over IPs resolved at boot; the way to close that policy's remaining holes (a
# rotating CDN address, no per-host ports, DNS as an outbound channel) is a proxy moat owns — but
# only if the agent's own HTTP client uses it. Both runtimes are third-party binaries, so this is a
# measurement about them, not a design decision.
#
#     bash test/proxy-spike.sh
#
# The shape: a recording endpoint on the host's loopback (which the runtime is configured to use)
# and a recording proxy on another port. Each runtime runs twice — once with the standard proxy
# variables set in the box and once without — and the two logs say which of them received the model
# request. Both recorders answer 502, so nothing is forwarded anywhere.
#
# The control is a *precondition*, not a footnote: if the runtime does not reach the endpoint with no
# proxy set, the run proves nothing about proxies and says UNKNOWN. The first version of this script
# lacked that check and reported a result for Claude that was an artefact of running it without the
# endpoint variables moat's `run` path sets (`cmd/main.ts`), so Claude talked to its own default
# host instead. A harness that cannot tell "the client refused the proxy" from "the client was never
# pointed at anything" is worse than no harness.
#
# What leaves the machine: nothing. Both recorders answer 502, and the endpoint is a loopback port.
# The runtimes do make their own background connections to their vendors' infrastructure — that is
# part of what the run measures — and in the control run those go direct, because the control is
# precisely "no proxy is set". moat's own suites behave the same way.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOAT="node $REPO/cmd/main.ts"
ENDPOINT_PORT="${ENDPOINT_PORT:-47421}"
PROXY_PORT="${PROXY_PORT:-47411}"
export MOAT_MOCK_CREDENTIAL="moat-proxy-spike-credential"

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/moat-proxy-XXXXXX")
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  # Destroy only this run's environments, by project path — never in a loop over envs/.
  for d in "$SCRATCH"/project-*; do
    [ -d "$d" ] && ( cd "$d" && $MOAT destroy --yes >/dev/null 2>&1 )
  done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

say() { printf '%s\n' "$*"; }
mark() { printf '  %-9s %s%s\n' "$1" "$2" "${3:+ — $3}"; }
# `grep -c` prints 0 **and exits 1** when nothing matches, so `$(grep -c . f || echo 0)` yields two
# lines and every comparison against "0" fails — a check that fails on success, which is the trap
# AGENTS.md records. Command substitution keeps the printed 0; the fallback only covers a missing
# file.
count() {
  local n
  n=$(grep -c . "$1" 2>/dev/null)
  printf '%s' "${n:-0}"
}

say "=================================================================="
say "moat egress spike: does the runtime use a proxy?"
say "=================================================================="
say ""

if ! command -v python3 >/dev/null 2>&1; then
  mark BLOCKED "no python3 to run the recorders"
  exit 0
fi

# One recorder, two roles. It logs the first line of whatever request arrives and answers 502, so a
# line in a log is proof the client sent the request *there*, and nothing is forwarded anywhere.
cat > "$SCRATCH/recorder.py" <<'PY'
import socket, sys, threading
port, log = int(sys.argv[1]), sys.argv[2]
addr = sys.argv[3] if len(sys.argv) > 3 else "127.0.0.1"
code = int(sys.argv[4]) if len(sys.argv) > 4 else 502
open(log, "w").close()
def handle(c):
    try:
        c.settimeout(10)
        line = c.recv(8192).split(b"\r\n", 1)[0].decode("utf8", "replace").strip()
        with open(log, "a") as f:
            f.write(line + "\n")
        c.sendall(b"HTTP/1.1 %d %s\r\ncontent-length: 0\r\n\r\n" % (code, b"OK" if code == 200 else b"Bad Gateway"))
    except Exception:
        pass
    finally:
        c.close()
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind((addr, port))
s.listen(32)
while True:
    conn, _ = s.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
PY

# No `setsid`: `$!` for a wrapped command is the wrapper's pid, which exits immediately, and that is
# how the microVM spike left a listener running — which then makes the next run's control report a
# false UNKNOWN, the one failure mode a control exists to prevent.
python3 "$SCRATCH/recorder.py" "$ENDPOINT_PORT" "$SCRATCH/endpoint.log" > "$SCRATCH/endpoint.out" 2>&1 &
PIDS+=($!)
python3 "$SCRATCH/recorder.py" "$PROXY_PORT" "$SCRATCH/proxy.log" > "$SCRATCH/proxy.out" 2>&1 &
PIDS+=($!)
sleep 1
say "  endpoint  recording on 127.0.0.1:$ENDPOINT_PORT (the provider the runtime is pointed at)"
say "  proxy     recording on 127.0.0.1:$PROXY_PORT (the standard variables point here)"
say ""

for RT in codex claude; do
  DIR="$SCRATCH/project-$RT"
  rm -rf "$DIR"; mkdir -p "$DIR"
  (
    cd "$DIR"
    git init -q -b main . >/dev/null 2>&1
    git config user.email spike@example.com
    git config user.name spike
    printf '{"name":"proxy-spike","scripts":{"test":"true"}}\n' > package.json
    git add -A && git commit -qm base
  )

  say "== $RT"
  say ""
  if ! ( cd "$DIR" && $MOAT up --quiet --egress open --runtime "$RT" --no-detect --model deepseek-flash \
        --base-url "http://127.0.0.1:$ENDPOINT_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL ) > "$SCRATCH/up-$RT.log" 2>&1; then
    mark BLOCKED "$RT: the box did not boot" "$(tail -1 "$SCRATCH/up-$RT.log")"
    say ""
    continue
  fi

  # Codex reads its endpoint from the config moat renders, so nothing has to be passed. Claude reads
  # ANTHROPIC_BASE_URL, which moat's `run` path sets and `moat exec` does not, so the two variables a
  # run would carry are set here by hand — otherwise Claude falls back to its own default host and
  # the run measures nothing.
  if [ "$RT" = codex ]; then
    TURN='MOAT_INJECTED_CREDENTIAL=spike timeout 40 codex exec --json "say hi"'
  else
    TURN="ANTHROPIC_BASE_URL=http://127.0.0.1:$ENDPOINT_PORT ANTHROPIC_API_KEY=spike timeout 40 sh -c \"printf %s 'say hi' | claude -p --output-format stream-json --verbose\""
  fi

  : > "$SCRATCH/endpoint.log"; : > "$SCRATCH/proxy.log"
  ( cd "$DIR" && $MOAT exec -- sh -c "$TURN" ) >/dev/null 2>&1
  C_ENDPOINT=$(count "$SCRATCH/endpoint.log")
  C_PROXY=$(count "$SCRATCH/proxy.log")

  : > "$SCRATCH/endpoint.log"; : > "$SCRATCH/proxy.log"
  ( cd "$DIR" && $MOAT exec -- sh -c \
      "HTTP_PROXY=http://127.0.0.1:$PROXY_PORT HTTPS_PROXY=http://127.0.0.1:$PROXY_PORT ALL_PROXY=http://127.0.0.1:$PROXY_PORT NO_PROXY= no_proxy= $TURN" \
    ) > "$SCRATCH/run-$RT.log" 2>&1
  T_ENDPOINT=$(count "$SCRATCH/endpoint.log")
  T_PROXY=$(count "$SCRATCH/proxy.log")

  say "  control, no proxy variables : endpoint $C_ENDPOINT request(s), proxy $C_PROXY"
  say "  with HTTP(S)_PROXY set     : endpoint $T_ENDPOINT request(s), proxy $T_PROXY"
  say "  what the proxy received (distinct):"
  sort -u "$SCRATCH/proxy.log" | sed 's/^/    /'
  say ""

  if [ "$C_ENDPOINT" = "0" ]; then
    mark UNKNOWN "$RT never reached the endpoint even with no proxy set" "the run says nothing about proxies until this leg works"
  elif [ "$C_PROXY" != "0" ]; then
    mark UNKNOWN "$RT: the control is not a control" "the proxy received traffic with no proxy variables set"
  elif [ "$T_PROXY" = "0" ]; then
    mark MEASURED "$RT does NOT use the proxy" "a moat-owned egress proxy cannot be the datapath for this runtime"
  elif [ "$T_ENDPOINT" != "0" ]; then
    mark UNKNOWN "$RT used the proxy and still reached the endpoint directly" "some traffic bypassed it"
  else
    mark MEASURED "$RT sends its model traffic through the proxy" "the standard variables are enough: no per-runtime integration for the proxying itself"
  fi
  say ""
done

# ---------------------------------------------------------------------------
# Where can the proxy live? It has to be reachable from the box, and the box's other two egress
# modes close the host's loopback deliberately — so "the host's namespace, on 127.0.0.1" is the one
# placement most likely not to work.
say "== where a proxy can live: the box's other egress modes, and the host's addresses"
say ""
HOSTIP=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
if [ -z "$HOSTIP" ]; then
  mark BLOCKED "this host has no non-loopback address" "there is nothing to place a listener on"
else
  DIR="$SCRATCH/project-isolated"
  rm -rf "$DIR"; mkdir -p "$DIR"
  (
    cd "$DIR"
    git init -q -b main . >/dev/null 2>&1
    git config user.email spike@example.com
    git config user.name spike
    printf '{"name":"isolated","scripts":{"test":"true"}}\n' > package.json
    git add -A && git commit -qm base
  )
  if ( cd "$DIR" && $MOAT up --quiet --egress isolated --no-detect --model deepseek-flash \
        --base-url "http://127.0.0.1:$ENDPOINT_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL ) > "$SCRATCH/up-isolated.log" 2>&1; then
    say "  a listener on the host's own address $HOSTIP:$ENDPOINT_PORT (recording)"
    python3 "$SCRATCH/recorder.py" "$ENDPOINT_PORT" "$SCRATCH/host.log" "$HOSTIP" 200 > "$SCRATCH/host.out" 2>&1 &
    PIDS+=($!)
    sleep 1
    if curl -s -o /dev/null --max-time 3 "http://$HOSTIP:$ENDPOINT_PORT/" 2>/dev/null; then
      mark MEASURED "control: the host reaches its own $HOSTIP" "so a refusal below is not a dead listener"
    else
      mark UNKNOWN "control: the host cannot reach its own $HOSTIP" "the rows below mean nothing"
    fi
    OUT=$( cd "$DIR" && $MOAT exec -- sh -c "
      timeout 6 wget -q -O /dev/null http://1.1.1.1/ && echo outbound=OK || echo outbound=no
      timeout 5 wget -q -O /dev/null http://$HOSTIP:$ENDPOINT_PORT/ && echo hostaddr=REACHED || echo hostaddr=refused
      timeout 5 wget -q -O /dev/null http://10.0.2.2:$ENDPOINT_PORT/ && echo gateway=REACHED || echo gateway=refused
    " 2>/dev/null )
    say "$(printf '%s\n' "$OUT" | sed 's/^/    /')"
    say ""
    if printf '%s' "$OUT" | grep -q "outbound=no"; then
      mark UNKNOWN "the isolated box has no uplink at all" "nothing here is about the proxy"
    elif printf '%s' "$OUT" | grep -q "gateway=REACHED"; then
      mark BLOCKED "the host's loopback is reachable from an isolated box" "that is the property --disable-host-loopback exists for, and it is broken"
    elif printf '%s' "$OUT" | grep -q "hostaddr=REACHED"; then
      mark MEASURED "a host-side proxy IS reachable from an isolated box — on the host's non-loopback address" "the loopback stays closed; the listener is on the LAN, so it has to be bound and authenticated deliberately"
    else
      mark MEASURED "a host-side proxy is NOT reachable from an isolated box" "the proxy would have to live inside the box or in its namespace instead"
    fi
    # The placement that would avoid all of that: a host process in the box's own namespace. It is
    # how slirp4netns appeared to work, and it does not: slirp runs in the HOST's namespace and
    # creates the tap from outside.
    BOXPID=$( cd "$DIR" && $MOAT status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("pid") or "")' )
    if [ -n "$BOXPID" ] && command -v nsenter >/dev/null 2>&1; then
      if nsenter --target "$BOXPID" --net -- true 2>/dev/null; then
        mark MEASURED "an ordinary process CAN enter the box's network namespace" "a proxy could be a host-side sibling of the box's loopback"
      else
        mark MEASURED "an ordinary process CANNOT enter the box's network namespace" "$(nsenter --target "$BOXPID" --net -- true 2>&1 | tail -1)"
      fi
    fi
  else
    mark BLOCKED "the isolated box did not boot" "$(tail -1 "$SCRATCH/up-isolated.log")"
  fi
fi
say ""

# ---------------------------------------------------------------------------
# A name-based policy refuses the hosts a runtime calls besides the model. Does a turn notice? The
# runtimes reach for their vendors' infrastructure on their own, and the policy has to answer for it.
say "== does the policy's treatment of the vendor hosts break a turn?"
say ""
RESPONSES_STUB="$REPO/stub/mock-responses.mjs"
if [ ! -f "$RESPONSES_STUB" ]; then
  mark BLOCKED "no Responses stub to run a real turn against"
else
  DIR="$SCRATCH/project-vendor"; mkdir -p "$DIR/src"
  (
    cd "$DIR"
    git init -q -b main . >/dev/null 2>&1
    git config user.email spike@example.com; git config user.name spike
    printf '{"name":"vendor","scripts":{"test":"true"}}\n' > package.json
    printf 'export const sum = (a, b) => a - b\n' > src/sum.js
    git add -A && git commit -qm base
  )
  VENDOR_PORT=$((ENDPOINT_PORT + 1))
  STUB_PID=""
  start_stub() { # a fresh stub per turn: it serves its scripted turns in sequence, so one stub for
                 # two turns would make the second one incomparable
    [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
    : > "$SCRATCH/rec-$1.jsonl"
    node "$RESPONSES_STUB" --port "$VENDOR_PORT" --script "$REPO/test/scripts/responses-basic.json" \
      --record "$SCRATCH/rec-$1.jsonl" > "$SCRATCH/stub-$1.log" 2>&1 &
    STUB_PID=$!
    PIDS+=($!)
    sleep 1.2
  }
  set_vendor() { # set_vendor <address|reset> — the box is the agent's, so this is what a policy
                 # looks like from the runtime's side. No value here may be a common word: moat
                 # scans the rootfs for the credential's value and REFUSES the boot if it finds it,
                 # and "probe" is in the agent brief for an open-egress box.
    ( cd "$DIR" && $MOAT exec -- sh -c "
      sed -i '/github.com\|chatgpt.com\|anthropic.com\|datadoghq.com/d' /etc/hosts
      [ '$1' = reset ] || printf '%s github.com\n%s api.github.com\n%s chatgpt.com\n' '$1' '$1' '$1' >> /etc/hosts
    " ) >/dev/null 2>&1
  }
  if ( cd "$DIR" && $MOAT up --quiet --egress open --no-detect --model deepseek-flash \
        --base-url "http://127.0.0.1:$VENDOR_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL ) > "$SCRATCH/up-vendor.log" 2>&1; then
    run_turn() { # run_turn <label>
      local before after rc reqs tokens
      start_stub "$1"
      before=$(date +%s%N)
      ( cd "$DIR" && $MOAT run --effort high --credential-env MOAT_MOCK_CREDENTIAL "Make the failing test pass." ) \
        > "$SCRATCH/turn-$1.log" 2>&1
      rc=$?; after=$(date +%s%N)
      reqs=$(count "$SCRATCH/rec-$1.jsonl")
      tokens=$(grep -oE '[0-9]+ tokens' "$SCRATCH/turn-$1.log" | tail -1)
      printf '  %-12s exit=%s  %sms  model requests=%s  %s\n' "$1" "$rc" "$(( (after-before)/1000000 ))" "$reqs" "${tokens:-no footer}"
      eval "REQ_$1=$reqs; RC_$1=$rc; TOK_$1=\$tokens"
    }
    say "  a turn with the vendor hosts reachable, then refused, then black-holed:"
    set_vendor reset;      run_turn reachable
    set_vendor 127.0.0.1;  run_turn refused
    set_vendor 10.255.255.1; run_turn blackholed
    say ""
    if [ "${RC_reachable:-1}" != "0" ]; then
      mark UNKNOWN "the control turn did not complete" "nothing here is about the policy"
    elif [ "${RC_refused:-1}" = "0" ] && [ "${RC_blackholed:-1}" = "0" ] \
      && [ "${REQ_refused:-x}" = "${REQ_reachable:-y}" ] && [ "${REQ_blackholed:-x}" = "${REQ_reachable:-y}" ]; then
      mark MEASURED "a refused or dropped vendor host does not change what a turn does" "same model requests, same tokens, exit 0 — and the turn is faster, which is what the policy would buy"
    else
      mark UNKNOWN "the policy's treatment of the vendor hosts changed the turn" "see the rows above"
    fi
    set_vendor reset
  else
    mark BLOCKED "the box for the vendor-host turn did not boot" "$(tail -1 "$SCRATCH/up-vendor.log")"
  fi
fi
say ""

say "=================================================================="
say "What this run measured, and what it did not"
say "=================================================================="
say ""
say "  measured    whether each runtime's own HTTP client sends its model traffic through a proxy"
say "              when HTTP_PROXY/HTTPS_PROXY/ALL_PROXY are set in the box, against a control with"
say "              none set, and which other hosts each runtime also talks to"
say "  measured    where a proxy can live, for the box's other two egress modes: an isolated"
say "              box refuses the host's loopback on both routes, but reaches the host's"
say "              non-loopback address, and an ordinary process cannot enter the box's namespace"
say "  not measured  that moat can *set* those variables: MOAT_SANDBOX_ENV accepts only MOAT_ names"
say "              (sandbox/launcher.ts), so a proxy is a managed-env change rather than config;"
say "              the same placement question under a container or microVM backend"
say "              (docs/MICROVM.md §4–§5)"
say "  measured    whether refusing or dropping those hosts changes what a turn does, on a keyless"
say "              turn against the Responses stub: it does not, and the turn is ~8x faster"
say "  not measured  the authenticated path (a real key's account traffic was never exercised), and"
say "              the same for Claude — its vendor set is api.anthropic.com and Datadog"
say ""
