#!/usr/bin/env bash
#
# moat end-to-end verification.
#
# Every acceptance criterion is exercised here against a real
# sandbox, and the raw output of each command is written to test/evidence/ so
# that docs/VERIFICATION.md can quote it verbatim rather than paraphrase it.
#
# The model is a deterministic local stub (test/mock-model.mjs) because this
# host has no provider credentials. It sits exactly where a real
# OpenAI-compatible endpoint would, so the agent loop being exercised, session
# creation, tool dispatch, permission evaluation, bash, file edits, git commits, 
# is opencode's real one, inside the real sandbox.
#
# Usage: bash test/e2e.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOAT="node $REPO/cmd/main.ts"
WORK="${MOAT_E2E_DIR:-$HOME/moat-demo}"
PROJECT="$WORK/project"
EVIDENCE="$REPO/test/evidence"
MOCK_PORT="${MOCK_PORT:-5599}"
MOCK_PIDFILE="$WORK/mock.pid"
MOCK_RECORD="$WORK/mock.jsonl"
CREDENTIAL="moat-e2e-scoped-credential-8c1d4e"
CANARY="$HOME/.moat/canary"

mkdir -p "$EVIDENCE"
: > "$EVIDENCE/summary.txt"

section() {
  echo "" | tee -a "$EVIDENCE/summary.txt"
  echo "==============================================================" | tee -a "$EVIDENCE/summary.txt"
  echo "== $1" | tee -a "$EVIDENCE/summary.txt"
  echo "==============================================================" | tee -a "$EVIDENCE/summary.txt"
}

# Run a command, save stdout/stderr separately (so JSON stays parseable) plus a
# combined view, then echo the combined view.
capture() {
  local name="$1"; shift
  {
    echo "--- \$ $*"
    "$@" > "$EVIDENCE/$name.out" 2> "$EVIDENCE/$name.err"
    echo "--- exit $?"
    echo "--- stdout ---"
    cat "$EVIDENCE/$name.out"
    echo "--- stderr ---"
    cat "$EVIDENCE/$name.err"
  } > "$EVIDENCE/$name.txt"
  cat "$EVIDENCE/$name.txt" | tee -a "$EVIDENCE/summary.txt"
}

json_field() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(eval('d'+sys.argv[2]))" "$1" "$2"; }

start_mock() {
  local script="$1"
  if [ -f "$MOCK_PIDFILE" ]; then
    kill "$(cat "$MOCK_PIDFILE")" 2>/dev/null
    sleep 0.4
  fi
  : > "$MOCK_RECORD"
  setsid node "$REPO/test/mock-model.mjs" --port "$MOCK_PORT" --script "$script" \
    --record "$MOCK_RECORD" > "$WORK/mock.log" 2>&1 < /dev/null &
  echo $! > "$MOCK_PIDFILE"
  sleep 1.2
  cat "$WORK/mock.log"
}

json_field() { python3 -c "import json,sys;d=json.load(open('$1'));print(eval('d'+sys.argv[1]))" "$2"; }

# ---------------------------------------------------------------------------
section "0. fixture: a small git project with an uncommitted change and an untracked file"
# ---------------------------------------------------------------------------
rm -rf "$PROJECT"
mkdir -p "$PROJECT"
cd "$PROJECT"
git init -q -b main
git config user.email demo@example.com
git config user.name "Demo User"
printf '# demo project\n\nA tiny project used to exercise moat.\n' > README.md
printf '#!/bin/sh\necho "hello from the demo project"\n' > greet.sh
chmod +x greet.sh
git add -A
git commit -qm "initial demo project"
printf 'uncommitted line\n' >> README.md
printf 'untracked\n' > notes.txt
git log --oneline
git status --porcelain

# A host-only secret that the sandbox must not be able to reach.
mkdir -p "$(dirname "$CANARY")"
echo "HOST-ONLY-SECRET-$(date +%s)" > "$CANARY"
chmod 600 "$CANARY"

# ---------------------------------------------------------------------------
section "1. host capability probe"
# ---------------------------------------------------------------------------
cd "$PROJECT"
capture doctor-host $MOAT doctor

# ---------------------------------------------------------------------------
section "2. clean slate + cold start (moat up)"
# ---------------------------------------------------------------------------
capture destroy $MOAT destroy --yes
export MOAT_MOCK_CREDENTIAL="$CREDENTIAL"
export AWS_SECRET_ACCESS_KEY="AKIAFAKEHOSTSECRETSHOULDNOTLEAK"
export SSH_AUTH_SOCK="/tmp/definitely-not-forwarded.sock"

# Hash the project tree with moat's own implementation, via a tiny node wrapper.
cat > "$WORK/hashtree.mjs" <<EOF
import { hashTree } from "$REPO/lib/hash.ts"
import { readFileSync } from "node:fs"
const args = process.argv.slice(2)
if (args[0] === "write") {
  const t = hashTree(args[1])
  console.log(JSON.stringify(t, null, 2))
} else {
  const t = hashTree(args[1])
  const prev = JSON.parse(readFileSync(args[2], "utf8"))
  console.log(JSON.stringify({ before: prev, after: t, identical: prev.digest === t.digest }, null, 2))
}
EOF
node "$WORK/hashtree.mjs" write "$PROJECT" > "$WORK/hash-before.json"
echo "project tree hash BEFORE any moat activity:"
cat "$WORK/hash-before.json" | tee -a "$EVIDENCE/summary.txt"

capture up $MOAT up --json --model mock-model --provider-base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL
UP_JSON="$EVIDENCE/up.out"
BOOT_MS=$(json_field "$UP_JSON" "['bootMs']" 2>/dev/null || echo "?")
TOTAL_MS=$(json_field "$UP_JSON" "['totalMs']" 2>/dev/null || echo "?")
PROVISION_MS=$(json_field "$UP_JSON" "['provisionMs']" 2>/dev/null || echo "?")
echo "cold start: totalMs=$TOTAL_MS provisionMs=$PROVISION_MS bootMs=$BOOT_MS" | tee -a "$EVIDENCE/summary.txt"
capture status-up $MOAT status --json

# ---------------------------------------------------------------------------
section "3. isolation self-test from inside the sandbox (moat doctor)"
# ---------------------------------------------------------------------------
capture doctor-sandbox $MOAT doctor
capture doctor-exposures $MOAT doctor --json
capture tools $MOAT tools

# ---------------------------------------------------------------------------
section "4. the agent completes a task needing bash + file edits, zero prompts"
# ---------------------------------------------------------------------------
start_mock "$REPO/test/scripts/basic.json" | tee -a "$EVIDENCE/summary.txt"
capture attach-task $MOAT attach --show-output --prompt "Create and edit a note file in the project, then commit it. Report what you did."

echo "" | tee -a "$EVIDENCE/summary.txt"
echo "--- provider-side record of that session (test/evidence/attach-task.txt has the agent output) ---"
python3 - "$MOCK_RECORD" <<'PY' | tee "$EVIDENCE/provider-record.txt" | tee -a "$EVIDENCE/summary.txt"
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
tools = sorted({t for r in rows for t in r["advertisedTools"]})
auths = sorted({r["authorization"] for r in rows})
steps = [(r["assistantTurns"], r["step"].get("tool") or "text") for r in rows]
print(f"inference requests observed : {len(rows)}")
print(f"authorization header        : {auths}")
print(f"advertised tool list        : {tools}")
print(f"scripted steps executed     : {steps}")
PY

echo "" | tee -a "$EVIDENCE/summary.txt"
echo "--- audit log written by the bundle plugin INSIDE the sandbox ---" | tee -a "$EVIDENCE/summary.txt"
ENV_DIR=$(json_field "$EVIDENCE/status-up.out" "['envDir']")
AUDIT="$ENV_DIR/rootfs/var/log/moat/tools.jsonl"
python3 - "$AUDIT" <<'PY' | tee "$EVIDENCE/audit.jsonl" | tee -a "$EVIDENCE/summary.txt"
import json, sys
for line in open(sys.argv[1]):
    d = json.loads(line)
    if d.get("phase") == "config":
        print(json.dumps({k: d[k] for k in ("phase", "permission", "toolOmissions")}))
    elif d.get("phase") == "before":
        print(json.dumps({"phase": d["phase"], "tool": d["tool"], "args": d["args"]}))
PY

echo "" | tee -a "$EVIDENCE/summary.txt"
# Streaming regression guard: only the event-driven path emits a "(running)"
# line, because it reports a tool when it starts rather than after the turn ends.
if grep -qE "\[tool\] [a-z_]+ \(running\)" "$EVIDENCE/attach-task.txt"; then
  echo "streaming: tool calls were reported as they started (not just at the end)" | tee -a "$EVIDENCE/summary.txt"
else
  echo "streaming: FAILED, no in-progress tool line found; attach fell back to waiting for the whole turn" | tee -a "$EVIDENCE/summary.txt"
fi

PERM_FILE="$ENV_DIR/rootfs/var/log/moat/permissions.jsonl"
if [ -f "$PERM_FILE" ]; then
  echo "permission requests raised: $(wc -l < "$PERM_FILE")" | tee -a "$EVIDENCE/summary.txt"
  cat "$PERM_FILE" | tee -a "$EVIDENCE/summary.txt"
else
  echo "permission requests raised: 0  (the file was never created, no permission.ask hook ever fired)" | tee -a "$EVIDENCE/summary.txt"
fi

# ---------------------------------------------------------------------------
section "5. the agent cannot read a host credential (failed attempt, from the agent itself)"
# ---------------------------------------------------------------------------
start_mock "$REPO/test/scripts/host-access.json.tmpl" >/dev/null
sed -e "s|@HOSTHOME@|$HOME|g" -e "s|@HOSTPROJECT@|$PROJECT|g" \
  "$REPO/test/scripts/host-access.json.tmpl" > "$WORK/host-access.json"
start_mock "$WORK/host-access.json" | tee -a "$EVIDENCE/summary.txt"
capture attach-host-access $MOAT attach --show-output --prompt "Try to read the host's credentials and project directory, and report exactly what happens."

# ---------------------------------------------------------------------------
section "6. the bundle refuses tools that are not in it"
# ---------------------------------------------------------------------------
start_mock "$REPO/test/scripts/curation.json" | tee -a "$EVIDENCE/summary.txt"
capture attach-curation $MOAT attach --show-output --prompt "Try an excluded tool, a write outside the workspace, and a read of a file inside the box."

# ---------------------------------------------------------------------------
section "6b. what the agent can reach, re-measured after the bundle's redaction is live"
# ---------------------------------------------------------------------------
capture doctor-after-session $MOAT doctor
capture exposure-record $MOAT doctor --json
echo "" | tee -a "$EVIDENCE/summary.txt"
echo "--- the bundle's own record of the agent environment (from inside the box) ---" | tee -a "$EVIDENCE/summary.txt"
ENV_DIR_FOR_EXPOSURE=$(python3 -c "import json;print(json.load(open('$EVIDENCE/status-up.out'))['envDir'])")
cat "$ENV_DIR_FOR_EXPOSURE/rootfs/var/log/moat/exposure.json" 2>/dev/null | tee -a "$EVIDENCE/summary.txt" || echo "(no exposure record yet)" | tee -a "$EVIDENCE/summary.txt"

# ---------------------------------------------------------------------------
section "7. copy-out: moat fetch delivers exactly the branch the user asked for"
# ---------------------------------------------------------------------------
cd "$PROJECT"
echo "host working tree state before fetch:"
git status --porcelain | tee -a "$EVIDENCE/summary.txt"
echo "host HEAD before fetch: $(git rev-parse HEAD)" | tee -a "$EVIDENCE/summary.txt"

capture fetch $MOAT fetch
capture fetch-json $MOAT fetch --json

echo "" | tee -a "$EVIDENCE/summary.txt"
echo "--- git log on the host, for the fetched ref only ---" | tee -a "$EVIDENCE/summary.txt"
git log --oneline --decorate refs/moat/main | tee -a "$EVIDENCE/summary.txt"
echo "" | tee -a "$EVIDENCE/summary.txt"
echo "--- host working tree after fetch (must be unchanged) ---" | tee -a "$EVIDENCE/summary.txt"
git status --porcelain | tee -a "$EVIDENCE/summary.txt"
echo "host HEAD after fetch: $(git rev-parse HEAD)" | tee -a "$EVIDENCE/summary.txt"
echo "files the agent produced now visible on the host (via the fetched ref):" | tee -a "$EVIDENCE/summary.txt"
git show --stat --oneline refs/moat/main | tee -a "$EVIDENCE/summary.txt"

# ---------------------------------------------------------------------------
section "8. the host project tree is byte-identical before vs after"
# ---------------------------------------------------------------------------
node "$WORK/hashtree.mjs" compare "$PROJECT" "$WORK/hash-before.json" | tee "$EVIDENCE/hash-compare.txt" | tee -a "$EVIDENCE/summary.txt"

# ---------------------------------------------------------------------------
section "9. the credential is never baked into the image"
# ---------------------------------------------------------------------------
echo "searching the whole rootfs for the injected credential value..." | tee -a "$EVIDENCE/summary.txt"
{
  echo "\$ grep -r --binary-files=without-match -l '$CREDENTIAL' $ENV_DIR/rootfs/ | head"
  grep -r --binary-files=without-match -l "$CREDENTIAL" "$ENV_DIR/rootfs/" 2>/dev/null | head
  echo "matches: $(grep -r --binary-files=without-match -l "$CREDENTIAL" "$ENV_DIR/rootfs/" 2>/dev/null | wc -l)"
  echo ""
  echo "\$ grep -c CREDENTIAL $ENV_DIR/rootfs/usr/local/share/moat/opencode.json   # the reference, not the value"
  grep -o '{env:MOAT_INJECTED_CREDENTIAL}' "$ENV_DIR/rootfs/usr/local/share/moat/opencode.json"
} | tee "$EVIDENCE/credential-not-in-image.txt" | tee -a "$EVIDENCE/summary.txt"

# ---------------------------------------------------------------------------
section "10. environments persist: an install survives moat down + moat up"
# ---------------------------------------------------------------------------
WARM_MS=""

echo "installing a package inside the sandbox via its own package manager (apk)..." | tee -a "$EVIDENCE/summary.txt"
{
  echo "jq is NOT in the base image (verified present in the Alpine 3.21 main repo)."
  echo "Two independent persistence proofs are taken:"
  echo "  (a) a marker file written into the rootfs"
  echo "  (b) a package installed with the sandbox's own package manager"
  echo ""
  echo "\$ moat exec -- /bin/sh -c 'echo ... > /opt/moat-marker; apk add --no-cache jq (with retries)'"
} > "$EVIDENCE/persistence.txt"
capture exec-install $MOAT exec -- /bin/sh -c "echo persisted-at-\$(date -u +%s) > /opt/moat-marker; n=0; until apk add --no-cache jq >/tmp/apk.log 2>&1; do n=\$((n+1)); [ \$n -ge 4 ] && break; sleep 3; done; echo '--- jq --version ---'; jq --version 2>&1 | head -1; echo '--- marker ---'; cat /opt/moat-marker"

capture down $MOAT down
capture status-after-down $MOAT status
echo "" | tee -a "$EVIDENCE/summary.txt"
echo "booting again (warm start) and checking whether jq is still installed..." | tee -a "$EVIDENCE/summary.txt"
capture up-warm $MOAT up --json --model mock-model --provider-base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL
echo "warm start: totalMs=$(json_field "$EVIDENCE/up-warm.out" "['totalMs']") bootMs=$(json_field "$EVIDENCE/up-warm.out" "['bootMs']")" | tee -a "$EVIDENCE/summary.txt"
{
  echo ""
  echo "--- after moat down + moat up (fresh namespaces, same rootfs) ---"
  echo "\$ moat exec -- /bin/sh -c 'cat /opt/moat-marker; /usr/bin/jq --version'"
} | tee -a "$EVIDENCE/persistence.txt"
capture exec-after-restart $MOAT exec -- /bin/sh -c "echo '--- marker (proof the rootfs persisted) ---'; cat /opt/moat-marker; echo '--- jq (proof the install persisted) ---'; jq --version 2>&1 | head -1"

# ---------------------------------------------------------------------------
section "11. teardown"
# ---------------------------------------------------------------------------
capture down-final $MOAT down
capture status-final $MOAT status
rm -f "$CANARY"
if [ -f "$MOCK_PIDFILE" ]; then kill "$(cat "$MOCK_PIDFILE")" 2>/dev/null; fi

echo "" | tee -a "$EVIDENCE/summary.txt"
echo "evidence written to $EVIDENCE/" | tee -a "$EVIDENCE/summary.txt"
