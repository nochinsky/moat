#!/usr/bin/env bash
# Real Pi tool loop and bounded-stop lifecycle under rootless Podman. Exit 77 is
# an explicit skip locally; the hosted CI step requires this suite to run/pass.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v podman >/dev/null || ! podman info >/dev/null 2>&1; then
  printf 'pi-container: SKIPPED (usable rootless Podman required; no container Pi turn was tested)\n' | tee "$REPO/test/evidence/pi-container.txt"
  exit 77
fi
source "$REPO/test/lib/pi-fixture.sh"
pi_fixture pi-container
pi_container_cleanup() {
  local rc=$?
  # Failure diagnostics may expose a removal regression. Reap only this fixture's
  # names before deleting its temp rootfs; never clear other users' containers.
  if [[ -n "${ENV_ID:-}" ]]; then
    while IFS= read -r name; do
      [[ -n "$name" ]] && podman rm -f "$name" >/dev/null 2>&1 || true
    done < <(containers)
  fi
  pi_cleanup "$rc"
}
trap pi_container_cleanup EXIT
export MOAT_CONTAINER_TEST_KEY='moat-container-test-credential-not-a-real-key-7128'
export HOST_ONLY_CONTAINER_CANARY='never-forward-container-canary'
HOST_IP=$(node -e 'const n=require("os").networkInterfaces(); console.log(Object.values(n).flat().find(a=>a.family==="IPv4"&&!a.internal)?.address||"")')
test -n "$HOST_IP"
cd "$PROJECT"
printf '{"name":"container-pi-project","type":"module","scripts":{"test":"node --test sum.test.js"}}\n' > package.json
printf 'export const sum = (a, b) => a - b\n' > sum.js
printf 'import {test} from "node:test"; import assert from "node:assert/strict"; import {sum} from "./sum.js"; test("adds", () => assert.equal(sum(1,2),3))\n' > sum.test.js
git init -q -b main
git config user.name 'Pi Container Test'; git config user.email 'container@moat.invalid'
git add -A; git commit -qm 'initial failing container project'
printf 'user work\n' > notes.txt
BEFORE=$(pi_hash); HEAD_BEFORE=$(git rev-parse HEAD); ENV_ID=$(pi_env_id)
containers() { podman ps -a --format '{{.Names}}' | awk -v prefix="moat-$ENV_ID" 'index($0,prefix)==1' | sort; }
assert_keepalive_only() { test "$(containers)" = "moat-$ENV_ID"; }
assert_no_containers() { test -z "$(containers)"; }
# Every request must reach the actual receiver with explicit auth; a footer alone
# cannot establish whether the containerized Pi made any model requests.
assert_requests() {
  node --input-type=module - "$RECORD" "$1" "${2:-credential}" <<'JS'
import fs from 'node:fs'; import assert from 'node:assert/strict'
const rows=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
assert.equal(rows.length,Number(process.argv[3]))
assert.ok(rows.every(r=>r.authorization===(process.argv[4]==='keyless'?null:`Bearer ${process.env.MOAT_CONTAINER_TEST_KEY}`)))
assert.ok(rows.every(r=>r.model==='mock-model'&&r.tools.includes('bash')))
JS
}
cat > "$WORK/task.json" <<'JSON'
{"turns":[{"tool":{"command":"test -z \"${HOST_ONLY_CONTAINER_CANARY:-}\" && sed -i 's/a - b/a + b/' sum.js && npm test && git add sum.js && git -c user.name=Agent -c user.email=agent@moat.invalid commit -qm 'container Pi fix'"}},{"text":"Container fix committed."}]}
JSON
pi_stub "$WORK/task.json" 0.0.0.0
pi_run up "${MOAT[@]}" up --quiet --backend container --egress filtered --no-detect --model mock-model --base-url "http://$HOST_IP:$PORT/v1" --credential-env MOAT_CONTAINER_TEST_KEY
pi_run rules "${MOAT[@]}" exec -- sh -c 'nft list ruleset | grep "policy drop"; id -u'
grep -q 'policy drop' "$WORK/rules.out"; grep -qx '0' "$WORK/rules.out"
pi_run task "${MOAT[@]}" run --quiet --json --timeout 60 --max-tokens 30000 --credential-env MOAT_CONTAINER_TEST_KEY 'fix the failing project and commit'
node - "$WORK/task.out" <<'JS'
const fs=require('fs'), assert=require('node:assert/strict');const r=JSON.parse(fs.readFileSync(process.argv[2]));assert.equal(r.code,0);assert.ok(r.tools.some(t=>t.kind==='bash'&&t.exitCode===0));assert.ok(r.usage.input+r.usage.cached+r.usage.output>0)
JS
assert_requests 2
assert_keepalive_only
pi_run take "${MOAT[@]}" take --quiet --json
node - "$WORK/take.out" <<'JS'
const r=JSON.parse(require('fs').readFileSync(process.argv[2])); if(r.treeUntouched!==true||r.checks.ok!==true||!r.reviewed.some(x=>x.path==='sum.js'))process.exit(1)
JS
test "$(pi_hash)" = "$BEFORE"; test "$(git rev-parse HEAD)" = "$HEAD_BEFORE"
pi_say 'pass: real Pi shell/edit/commit task and project checks ran under filtered Podman; receiving endpoint observed credential and usage; review left host HEAD/files unchanged'
# Concurrent ephemeral boots may coexist with the keepalive and each other.
"${MOAT[@]}" exec -- sh -c 'echo one; timeout 30 sh -c "while [ ! -e /opt/moat-concurrent-release ]; do sleep .1; done"' > "$WORK/one.out" 2> "$WORK/one.err" & ONE=$!
"${MOAT[@]}" exec -- sh -c 'echo two; timeout 30 sh -c "while [ ! -e /opt/moat-concurrent-release ]; do sleep .1; done"' > "$WORK/two.out" 2> "$WORK/two.err" & TWO=$!
for _ in {1..50}; do [[ "$(containers | wc -l)" -ge 3 ]] && break; sleep .1; done
test "$(containers | wc -l)" -ge 3
# Negative control: the same assertion must reject real ephemeral containers,
# rather than accidentally matching only the keepalive's exact name.
if assert_keepalive_only; then
  pi_say 'FAIL: the container cleanup matcher ignored active ephemeral boots'
  exit 1
fi
pi_run release "${MOAT[@]}" exec -- touch /opt/moat-concurrent-release
wait "$ONE"; wait "$TWO"
grep -qx one "$WORK/one.out"; grep -qx two "$WORK/two.out"
assert_keepalive_only
pi_say 'pass: concurrent ephemeral containers had independent names and left only the keepalive'
printf '{"turns":[{"tool":{"command":"sleep 25; printf leak > /opt/moat-budget-survived"}},{"text":"must not make this second request"}]}\n' > "$WORK/budget.json"
pi_stub "$WORK/budget.json" 0.0.0.0
set +e
pi_run budget "${MOAT[@]}" run --quiet --json --timeout 30 --max-tokens 100 --base-url "http://$HOST_IP:$PORT/v1" --credential-env MOAT_CONTAINER_TEST_KEY 'stop at the reported usage ceiling'
RC=$?
set -e
test "$RC" != 0
node - "$WORK/budget.out" <<'JS'
const r=JSON.parse(require('fs').readFileSync(process.argv[2])); if(r.code===0||!r.aborted?.includes('token ceiling')||r.timedOut)process.exit(1)
JS
assert_requests 1
assert_keepalive_only
pi_say 'pass: usage ceiling stopped the containerized Pi before its next request and removed its ephemeral container'
printf '{"turns":[{"tool":{"command":"printf started > /opt/moat-timeout-started; sleep 25; printf leak > /opt/moat-timeout-survived"}},{"text":"must not finish"}]}\n' > "$WORK/timeout.json"
pi_stub "$WORK/timeout.json" 0.0.0.0
set +e
pi_run timeout "${MOAT[@]}" run --quiet --json --timeout 10 --base-url "http://$HOST_IP:$PORT/v1" --credential-env MOAT_CONTAINER_TEST_KEY 'run a tool past the timeout'
RC=$?
set -e
test "$RC" != 0
node - "$WORK/timeout.out" <<'JS'
const r=JSON.parse(require('fs').readFileSync(process.argv[2])); if(r.code===0||!r.timedOut||r.credentialExpired||r.aborted)process.exit(1)
JS
assert_requests 1
assert_keepalive_only
pi_run timeoutWitness "${MOAT[@]}" exec -- sh -c 'test -f /opt/moat-timeout-started; test ! -e /opt/moat-timeout-survived'
pi_say 'pass: timeout killed a running Pi tool and removed its ephemeral container, preserving the keepalive'
pi_run expiryDown "${MOAT[@]}" down --quiet
assert_no_containers
printf '{"turns":[{"delayMs":30000,"text":"expired credential must not finish"}]}\n' > "$WORK/expiry.json"
pi_stub "$WORK/expiry.json" 0.0.0.0
set +e
pi_run expiry "${MOAT[@]}" run --quiet --json --timeout 40 --credential-ttl 10s --base-url "http://$HOST_IP:$PORT/v1" --credential-env MOAT_CONTAINER_TEST_KEY 'wait past credential expiry'
RC=$?
set -e
test "$RC" != 0
node - "$WORK/expiry.out" <<'JS'
const r=JSON.parse(require('fs').readFileSync(process.argv[2])); if(r.code!==124||!r.credentialExpired||r.timedOut||r.aborted||!r.errors.some(e=>e.includes('credential expired')))process.exit(1)
JS
assert_requests 1
for _ in {1..50}; do [[ -z "$(containers)" ]] && break; sleep .1; done
assert_no_containers
pi_say 'pass: credential deadline stopped an in-flight model request and removed both expired keepalive and ephemeral container'
printf '{"turns":[{"text":"Keyless container request finished."}]}\n' > "$WORK/keyless.json"
pi_stub "$WORK/keyless.json" 0.0.0.0
pi_run keyless "${MOAT[@]}" run --quiet --json --timeout 30 --no-credential --base-url "http://$HOST_IP:$PORT/v1" 'use a genuinely keyless endpoint'
node - "$WORK/keyless.out" <<'JS'
const r=JSON.parse(require('fs').readFileSync(process.argv[2]));if(r.code!==0)process.exit(1)
JS
assert_requests 1 keyless
assert_keepalive_only
pi_run finaldown "${MOAT[@]}" down --quiet
assert_no_containers
test "$(pi_hash)" = "$BEFORE"; test "$(git rev-parse HEAD)" = "$HEAD_BEFORE"
pi_say 'pass: keyless receiving endpoint saw no Authorization header; final down left no fixture containers'
pi_say 'pi-container: all criteria passed (real Pi task, filtered network, budgets, timeout, expiry, keyless auth, cleanup)'
