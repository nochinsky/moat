#!/usr/bin/env bash
#
# moat acceptance criteria, against a keyless model stub.
#
# There is one runtime (Codex), and it is a CLI rather than a server: moat drives it with
# `codex exec --json` for a task and hands the terminal to its TUI for a session. Everything
# here is measured through stub/mock-responses.mjs, which speaks the Responses wire API and
# replays event shapes captured from a real DeepSeek stream, so the whole list runs with no key.
#
# One acceptance criterion from the list this replaced is deliberately absent, and its absence
# is the honest part: the in-box permission/curation guard was an opencode plugin mechanism.
# Under Codex the same guarantee is the moat-rendered config (section 4 asserts the two
# load-bearing lines) and extras section AJ reads the whole file back out of the box.
#
# Usage: bash test/e2e-codex.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOAT="node $REPO/cmd/main.ts"
WORK="${MOAT_E2E_DIR:-$HOME/moat-demo}"
PROJECT="$WORK/codex-project"
EVIDENCE="$REPO/test/evidence"
MOCK_PORT="${MOCK_PORT:-5597}"
MOCK_PIDFILE="$WORK/responses-mock.pid"
MOCK_RECORD="$WORK/responses-record.jsonl"
CREDENTIAL="moat-e2e-codex-credential-7f3a91"
CANARY="$HOME/.moat/canary"
FAILED=0

mkdir -p "$EVIDENCE"
: > "$EVIDENCE/codex-summary.txt"

scrub() { sed -e "s|$HOME|/home/user|g" -e "s|${USER:-$(id -un)}|user|g"; }
scrub_evidence() {
  local f
  for f in "$EVIDENCE"/*.txt; do
    [ -f "$f" ] || continue
    sed -i -e "s|$HOME|/home/user|g" -e "s|${USER:-$(id -un)}|user|g" "$f"
  done
}
section() {
  echo "" | tee -a "$EVIDENCE/codex-summary.txt"
  echo "==============================================================" | tee -a "$EVIDENCE/codex-summary.txt"
  echo "== $1" | tee -a "$EVIDENCE/codex-summary.txt"
  echo "==============================================================" | tee -a "$EVIDENCE/codex-summary.txt"
}
say() { echo "$@" | tee -a "$EVIDENCE/codex-summary.txt"; }
verdict() {
  if [ "$1" = "0" ]; then say "  pass  $2"; else say "  FAIL  $2"; FAILED=1; fi
}
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
  } | scrub > "$EVIDENCE/$name.txt"
  cat "$EVIDENCE/$name.txt" | tee -a "$EVIDENCE/codex-summary.txt"
}
json_field() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(eval('d'+sys.argv[2]))" "$1" "$2"; }

start_mock() {
  if [ -f "$MOCK_PIDFILE" ]; then kill "$(cat "$MOCK_PIDFILE")" 2>/dev/null; sleep 0.4; fi
  : > "$MOCK_RECORD"
  setsid node "$REPO/stub/mock-responses.mjs" --port "$MOCK_PORT" --script "$1" \
    --record "$MOCK_RECORD" > "$WORK/responses-mock.log" 2>&1 < /dev/null &
  echo $! > "$MOCK_PIDFILE"
  sleep 1.2
  cat "$WORK/responses-mock.log"
}

section "0. fixture: a node project whose own test fails, a dirty tree, and a host canary"
rm -rf "$PROJECT"; mkdir -p "$PROJECT/src" "$PROJECT/test"
cd "$PROJECT"
cat > package.json <<'JSON'
{ "name": "codex-acceptance", "type": "module", "scripts": { "test": "node --test" } }
JSON
printf 'export const sum = (a, b) => a - b\n' > src/sum.js
printf '# codex acceptance fixture\n' > README.md
cat > test/sum.test.js <<'JS'
import test from "node:test"
import assert from "node:assert/strict"
import { sum } from "../src/sum.js"
test("adds", () => assert.equal(sum(1, 2), 3))
JS
git init -q -b main && git config user.email demo@example.com && git config user.name "Demo User"
git add -A && git commit -qm "initial project (the test fails)"
printf 'uncommitted line\n' >> README.md
printf 'untracked\n' > notes.txt
git log --oneline | tee -a "$EVIDENCE/codex-summary.txt"
git status --porcelain | tee -a "$EVIDENCE/codex-summary.txt"
mkdir -p "$(dirname "$CANARY")"
echo "HOST-ONLY-SECRET-$(date +%s)" > "$CANARY"; chmod 600 "$CANARY"

section "1. host capability probe"
capture codex-doctor-host $MOAT doctor

section "2. cold start on the default runtime"
capture codex-destroy $MOAT destroy --yes
export MOAT_MOCK_CREDENTIAL="$CREDENTIAL"
export AWS_SECRET_ACCESS_KEY="AKIAFAKEHOSTSECRETSHOULDNOTLEAK"
export SSH_AUTH_SOCK="/tmp/definitely-not-forwarded.sock"
cat > "$WORK/codex-hashtree.mjs" <<EOF
import { hashTree } from "$REPO/lib/hash.ts"
import { readFileSync } from "node:fs"
const args = process.argv.slice(2)
if (args[0] === "write") console.log(JSON.stringify(hashTree(args[1]), null, 2))
else {
  const after = hashTree(args[1])
  const before = JSON.parse(readFileSync(args[2], "utf8"))
  console.log(JSON.stringify({ before: before.digest, after: after.digest, identical: before.digest === after.digest }, null, 2))
}
EOF
node "$WORK/codex-hashtree.mjs" write "$PROJECT" > "$WORK/codex-hash-before.json"
capture codex-up $MOAT up --json --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL
capture codex-status $MOAT status --json
MODEL=$(json_field "$EVIDENCE/codex-status.out" "['model']" 2>/dev/null || echo "?")
EGRESS=$(json_field "$EVIDENCE/codex-status.out" "['egress']" 2>/dev/null || echo "?")
say "model: $MODEL   egress: $EGRESS"
[ "$MODEL" = "moat/mock-model" ] && verdict 0 "the environment was created with the model that was asked for" || verdict 1 "status does not record the requested model"
# There is one runtime, so the claim to assert is that the box actually has it: the binary, in
# the box, reporting its own version. The state file no longer records which runtime it is.
capture codex-binary $MOAT exec -- codex --version
grep -qE "^codex-cli [0-9]" "$EVIDENCE/codex-binary.txt" \
  && verdict 0 "the box carries the pinned Codex CLI, and it runs there" \
  || verdict 1 "no Codex CLI in the box"
[ "$EGRESS" = "open" ] && verdict 0 "egress is open for a provider on the host loopback (the documented exception)" || verdict 1 "egress is not open for a loopback provider"

section "3. isolation self-test from inside the sandbox"
capture codex-doctor $MOAT doctor
capture codex-doctor-json $MOAT doctor --json
grep -q "no variable from the host environment reached the sandbox" "$EVIDENCE/codex-doctor.txt" \
  && verdict 0 "the doctor env diff found no host variable in the box" \
  || verdict 1 "the doctor did not report a clean environment diff"
# The device nodes are host binds. This row measures that each one is a character device inside
# the box, which is what a swallowed bind failure used to break without a symptom.
grep -q "pass  device nodes are real devices" "$EVIDENCE/codex-doctor.txt" \
  && verdict 0 "the six /dev nodes are character devices inside the box, measured there" \
  || verdict 1 "a device node in the box is not a device"
# The control for that row: the probe's own test, run over one device and one regular file in a
# live box. (Breaking /dev/null itself is not possible from inside: it is a bind mount, so unlink
# fails with EBUSY — which is also why the boot verifies the bind instead of trusting `-e`.)
# Without this, "6/6 are character devices" is a claim no run of the suite could contradict.
capture codex-dev-control $MOAT exec -- sh -c 'M=""; for p in /dev/null /etc/hosts; do [ -c "$p" ] || M="$M $p"; done; echo "MOAT_DEV_MISSING=$(echo $M)"'
grep -q "MOAT_DEV_MISSING=/etc/hosts" "$EVIDENCE/codex-dev-control.txt" \
  && verdict 0 "control: the same test reports a regular file where a device is expected" \
  || verdict 1 "control: the device test does not distinguish a regular file from a device"

section "4. the agent completes a task needing bash + file edits, and the project checks pass"
start_mock "$REPO/test/scripts/responses-acceptance-task.json" | tee -a "$EVIDENCE/codex-summary.txt"
capture codex-run-task $MOAT run "Make the failing test pass, then commit it."
capture codex-config-in-box $MOAT exec -- sh -c 'cat /root/.codex/config.toml'
capture codex-verify $MOAT verify
grep -qE "pass +npm test" "$EVIDENCE/codex-verify.txt" && ! grep -qE "FAIL +npm test" "$EVIDENCE/codex-verify.txt" \
  && verdict 0 "the project own checks passed, run inside the box by moat" \
  || verdict 1 "moat verify did not report the project check passing"
grep -q '^approval_policy = "never"$' "$EVIDENCE/codex-config-in-box.txt" \
  && grep -q '^sandbox_mode = "danger-full-access"$' "$EVIDENCE/codex-config-in-box.txt" \
  && verdict 0 "approvals and Codex own sandbox are off in the config moat rendered" \
  || verdict 1 "the rendered config lacks the two lines that stand in for the permission guard"
# The run's own row is truncated for display, so the commit subject is asserted where it
# actually lives: the box's git log. The file name is early enough in the row to assert there.
capture codex-task-log $MOAT exec -- sh -c "git -C /work log --oneline -1"
grep -q "src/sum.js" "$EVIDENCE/codex-run-task.txt" && grep -q "fix: sum adds" "$EVIDENCE/codex-task-log.txt" \
  && verdict 0 "the agent edited the file and committed it (the row names the file, the box log names the commit)" \
  || verdict 1 "no edit+commit was found in the box"
say ""
say "--- provider-side record of the turn (from the stub) ---"
python3 - "$MOCK_RECORD" <<'PY' | tee "$EVIDENCE/codex-provider-record.txt" | tee -a "$EVIDENCE/codex-summary.txt"
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
tools = sorted({t for r in rows for t in (r.get("tools") or [])})
print("inference requests observed :", len(rows))
print("model                       :", rows[0].get("model") if rows else None)
print("tools advertised to the model:", tools)
print("reasoning field             :", rows[0].get("reasoning") if rows else None)
PY

section "5. the agent cannot read a host credential or the host project"
sed -e "s|@HOSTHOME@|$HOME|g" -e "s|@HOSTPROJECT@|$PROJECT|g" \
  "$REPO/test/scripts/responses-host-access.json.tmpl" > "$WORK/responses-host-access.json"
start_mock "$WORK/responses-host-access.json" >/dev/null
capture codex-run-host-access $MOAT run "Try to read the host credentials and project directory, and report what happens."
capture codex-exec-host-paths $MOAT exec -- sh -c "ls /home 2>&1; cat /root/.ssh/id_rsa 2>&1 | head -1; echo canary:; ls $CANARY 2>&1"
grep -q "No such file or directory" "$EVIDENCE/codex-exec-host-paths.txt" \
  && ! grep -q "HOST-ONLY-SECRET" "$EVIDENCE/codex-exec-host-paths.txt" \
  && verdict 0 "the host canary and the host home are unreachable from inside the box" \
  || verdict 1 "a host path was reachable from the box"
! grep -q "HOST-ONLY-SECRET" "$EVIDENCE/codex-run-host-access.txt" \
  && verdict 0 "the agent own attempt did not produce the canary contents" \
  || verdict 1 "the canary leaked into the agent report"

section "6. copy-out: moat fetch writes the session branch and nothing else"
cd "$PROJECT"
HEAD_BEFORE=$(git rev-parse HEAD)
STATUS_BEFORE=$(git status --porcelain)
capture codex-fetch $MOAT fetch
REFS=$(git for-each-ref --format="%(refname:short)" "refs/moat/*")
REF_COUNT=$(printf "%s\n" "$REFS" | grep -c . || true)
say "refs under refs/moat/: $REFS"
[ "$REF_COUNT" = "1" ] && verdict 0 "exactly one ref was written" || verdict 1 "expected exactly 1 ref"
git log --oneline --decorate "$REFS" | tee -a "$EVIDENCE/codex-summary.txt"
grep -q "fix: sum adds" "$EVIDENCE/codex-fetch.txt" \
  && verdict 0 "the fetched ref carries the agent commit" \
  || verdict 1 "the fetched ref does not show the agent commit"
[ "$HEAD_BEFORE" = "$(git rev-parse HEAD)" ] && verdict 0 "the host HEAD did not move" || verdict 1 "the host HEAD moved"
[ "$STATUS_BEFORE" = "$(git status --porcelain)" ] && verdict 0 "the host working tree is unchanged" || verdict 1 "the host working tree changed"

section "7. the host project tree is byte-identical before vs after"
node "$WORK/codex-hashtree.mjs" compare "$PROJECT" "$WORK/codex-hash-before.json" | tee "$EVIDENCE/codex-hash-compare.txt" | tee -a "$EVIDENCE/codex-summary.txt"
grep -q '"identical": true' "$EVIDENCE/codex-hash-compare.txt" \
  && verdict 0 "the tree hash is identical before and after" \
  || verdict 1 "the host tree hash changed"

section "8. the credential is never baked into the image"
ENV_DIR=$(json_field "$EVIDENCE/codex-status.out" "['envDir']")
{
  echo "\$ grep -r --binary-files=without-match -l <credential> $ENV_DIR/rootfs/ | head"
  grep -r --binary-files=without-match -l "$CREDENTIAL" "$ENV_DIR/rootfs/" 2>/dev/null | head
  echo "matches: $(grep -r --binary-files=without-match -l "$CREDENTIAL" "$ENV_DIR/rootfs/" 2>/dev/null | wc -l)"
  echo ""
  echo "the config references the env var, never the value:"
  grep -o 'env_key = "MOAT_INJECTED_CREDENTIAL"' "$ENV_DIR/rootfs/root/.codex/config.toml"
} | tee "$EVIDENCE/codex-credential-not-in-image.txt" | tee -a "$EVIDENCE/codex-summary.txt"
[ "$(grep -r --binary-files=without-match -l "$CREDENTIAL" "$ENV_DIR/rootfs/" 2>/dev/null | wc -l)" = "0" ] \
  && verdict 0 "the injected credential value appears nowhere in the rootfs" \
  || verdict 1 "the credential value was found inside the rootfs"
# `grep -c` prints 0 and *exits 1* when there is no match, so `|| echo 1` would append a
# second line to the count and make this check fail on success. Capture the count alone.
CONFIG_HITS=$(grep -c "$CREDENTIAL" "$ENV_DIR/rootfs/root/.codex/config.toml" 2>/dev/null || true)
[ "${CONFIG_HITS:-0}" = "0" ] \
  && verdict 0 "the box config names the variable, not the value" \
  || verdict 1 "the config carries the credential value"

section "9. environments persist: a marker and an install survive moat down + moat up"
capture codex-exec-install $MOAT exec -- /bin/sh -c "echo persisted-at-\$(date -u +%s) > /opt/moat-marker; n=0; until apk add --no-cache jq >/tmp/apk.log 2>&1; do n=\$((n+1)); [ \$n -ge 4 ] && break; sleep 3; done; echo jq:; jq --version 2>&1 | head -1"
capture codex-down $MOAT down
capture codex-up-warm $MOAT up --json --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL
capture codex-exec-after-restart $MOAT exec -- /bin/sh -c "cat /opt/moat-marker; jq --version 2>&1 | head -1"
grep -q "persisted-at-" "$EVIDENCE/codex-exec-after-restart.txt" && grep -qE "^jq-[0-9]" "$EVIDENCE/codex-exec-after-restart.txt" \
  && verdict 0 "the marker file and the installed package both survived a full stop and boot" \
  || verdict 1 "the marker or the package did not survive"

section "10. text from inside the box cannot drive the terminal it is printed on"
# The answer, the reasoning, tool output, commit subjects, branch names and the boot log all
# come from inside the box, and a terminal acts on the escape sequences in them: OSC 0 retitles
# the window, OSC 52 writes the clipboard where the terminal allows it, CSI 2J clears the
# screen. Every one of those print sites strips the ESC byte. The stub's scripted answer carries
# the three sequences, so this is measured on the bytes rather than argued.
start_mock "$REPO/test/scripts/responses-escape.json"
capture codex-escape-run $MOAT run "Print the text you were given, exactly as it is."
ESC_BYTES=$(grep -c $'\x1b' "$EVIDENCE/codex-escape-run.txt" 2>/dev/null || true)
[ "${ESC_BYTES:-0}" = "0" ] \
  && grep -q "clearing" "$EVIDENCE/codex-escape-run.txt" \
  && grep -q "and done" "$EVIDENCE/codex-escape-run.txt" \
  && verdict 0 "the answer's escape sequences were stripped and its text still arrived" \
  || verdict 1 "an escape byte from the box reached the terminal (${ESC_BYTES:-?} lines)"
# The control: the matcher detects an ESC byte when one is there, so the check above can fail.
printf 'control\x1b[2J' | grep -q $'\x1b' \
  && verdict 0 "control: the same matcher finds an ESC byte in a string that has one" \
  || verdict 1 "control: the matcher does not detect ESC bytes, so the check above proves nothing"
start_mock "$REPO/test/scripts/responses-acceptance-task.json"

section "11. teardown"
capture codex-down-final $MOAT down
capture codex-status-final $MOAT status
rm -f "$CANARY"
[ -f "$MOCK_PIDFILE" ] && kill "$(cat "$MOCK_PIDFILE")" 2>/dev/null

echo "" | tee -a "$EVIDENCE/codex-summary.txt"
scrub_evidence
if [ "$FAILED" = "0" ]; then
  say "acceptance (codex runtime): all criteria passed"
else
  say "acceptance (codex runtime): FAILED - see the FAIL lines above"
fi
exit $FAILED
