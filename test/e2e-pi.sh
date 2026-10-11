#!/usr/bin/env bash
# Keyless acceptance against the real pinned Pi in the real moat sandbox.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${MOAT_E2E_DIR:-$(mktemp -d /tmp/moat-pi-e2e.XXXXXX)}"
mkdir -p "$WORK"
PROJECT="$WORK/pi-project"
EVIDENCE="$REPO/test/evidence/pi-summary.txt"
MOAT=(node "$REPO/cmd/main.ts")
PORT="${MOCK_PORT:-5597}"
RECORD="$WORK/pi-record.jsonl"
MOCK_PID=""
export NO_COLOR=1
export MOAT_PI_TEST_KEY="moat-pi-test-credential-not-a-real-key-7128"
cleanup() {
  if [[ -n "$MOCK_PID" ]]; then kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true; fi
  (cd "$PROJECT" && "${MOAT[@]}" down --quiet) >/dev/null 2>&1 || true
}
trap cleanup EXIT
mkdir -p "$(dirname "$EVIDENCE")"
: > "$EVIDENCE"
say() { printf '%s\n' "$*" | tee -a "$EVIDENCE"; }
run() {
  local label="$1"; shift
  say "--- $label"
  "$@" > "$WORK/$label.out" 2> "$WORK/$label.err"
  cat "$WORK/$label.out" "$WORK/$label.err" > "$WORK/$label.txt"
  sed "s|$HOME|/home/user|g" "$WORK/$label.txt" >> "$EVIDENCE"
}
stub() {
  if [[ -n "$MOCK_PID" ]]; then kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true; fi
  : > "$RECORD"
  node "$REPO/stub/mock-responses.mjs" --host "${2:-127.0.0.1}" --port "$PORT" --script "$1" --record "$RECORD" > "$WORK/stub.log" 2>&1 &
  MOCK_PID=$!
  for _ in {1..50}; do grep -q listening "$WORK/stub.log" && return 0; sleep .1; done
  cat "$WORK/stub.log"; return 1
}
hash() { node --input-type=module -e "import {hashTree} from '$REPO/lib/hash.ts'; console.log(hashTree(process.cwd()).digest)"; }
mkdir -p "$PROJECT/src" "$PROJECT/test" "$PROJECT/.pi/extensions"
cd "$PROJECT"
printf '{"name":"pi-acceptance","type":"module","scripts":{"test":"node --test"}}\n' > package.json
printf 'export const sum = (a, b) => a - b\n' > src/sum.js
printf 'import {test} from "node:test"; import assert from "node:assert/strict"; import {sum} from "../src/sum.js"; test("adds", () => assert.equal(sum(1,2),3))\n' > test/sum.test.js
cat > .pi/extensions/witness.ts <<'TS'
import fs from "node:fs"
export default function (pi: any) {
  pi.on("session_start", () => fs.writeFileSync("/opt/pi-extension-witness", "extension ran inside the box\n"))
  pi.registerTool({
    name: "moat_noise", label: "Long-stream regression", description: "Emit inert JSON frames",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => {
      const line = JSON.stringify({ type: "ignored", text: "x".repeat(65536) }) + "\n"
      for (let i = 0; i < 90; i++) await new Promise<void>(resolve => process.stdout.write(line, () => resolve()))
      return { content: [{ type: "text", text: "noise finished" }], details: {} }
    },
  })
  pi.registerTool({
    name: "moat_probe", label: "In-box custom tool", description: "Write a sandbox-only witness",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => {
      fs.writeFileSync("/opt/pi-custom-tool-witness", "custom tool ran inside the box\n")
      return { content: [{ type: "text", text: "custom tool ran" }], details: {} }
    },
  })
}
TS
git init -q -b main
git config user.name 'Pi Test'; git config user.email 'pi-test@moat.invalid'
git add -A; git commit -qm 'initial failing project'
printf 'dirty host work\n' > notes.txt
BEFORE=$(hash)
HOST_HEAD=$(git rev-parse HEAD)
export SSH_AUTH_SOCK='/tmp/not-forwarded-moat-pi-test'
export AWS_SECRET_ACCESS_KEY='HOST-ONLY-Pi-TEST-CANARY'
stub "$REPO/test/scripts/responses-acceptance-task.json"
run up "${MOAT[@]}" up --quiet --no-detect --model mock-model --base-url "http://127.0.0.1:$PORT/v1" --credential-env MOAT_PI_TEST_KEY
run binary "${MOAT[@]}" exec -- sh -c 'pi --version; node --version; command -v codex || true; command -v claude || true'
grep -q '^1.1.0$' "$WORK/binary.out"
! grep -qE '/usr/local/bin/(codex|claude)' "$WORK/binary.out"
run doctor "${MOAT[@]}" doctor
grep -q 'no variable from the host environment reached the sandbox' "$WORK/doctor.txt"
grep -q 'pass  device nodes are real devices' "$WORK/doctor.txt"
run task "${MOAT[@]}" run --quiet --credential-env MOAT_PI_TEST_KEY --show-output 'Make the failing test pass, then commit it.'
run verify "${MOAT[@]}" verify
grep -qE 'pass +npm test' "$WORK/verify.txt"
run extension "${MOAT[@]}" exec -- cat /opt/pi-extension-witness
grep -q 'extension ran inside the box' "$WORK/extension.out"
node --input-type=module - "$RECORD" <<'JS'
import assert from 'node:assert/strict'; import fs from 'node:fs'
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse)
assert.ok(rows.length >= 2)
assert.ok(rows.some(r => r.tools.includes('bash')))
assert.ok(rows.every(r => r.tools.includes('moat_probe')))
assert.ok(rows.some(r => r.body.includes('disposable Linux container')))
assert.ok(rows.every(r => r.authorization === `Bearer ${process.env.MOAT_PI_TEST_KEY}`))
assert.ok(rows.every(r => r.reasoning?.effort === 'high'))
console.log('provider record: explicit model, credential, effort, Pi tools and moat brief observed')
JS
say 'pass: Pi ran a shell/edit/commit task and loaded a project extension inside the sandbox'
printf '{"turns":[{"toolName":"moat_probe","tool":{}},{"text":"custom tool finished"}]}\n' > "$WORK/custom.json"
stub "$WORK/custom.json"
run customtool "${MOAT[@]}" run --quiet --credential-env MOAT_PI_TEST_KEY 'use the custom tool'
run customcheck "${MOAT[@]}" exec -- cat /opt/pi-custom-tool-witness
grep -q 'custom tool ran inside the box' "$WORK/customcheck.out"
say 'pass: the model invoked a project-registered custom tool inside the sandbox'
run hostpaths "${MOAT[@]}" exec -- sh -c "test ! -e '$PROJECT'; test ! -e '$HOME/.ssh'; test -z \"\${SSH_AUTH_SOCK:-}\"; test -z \"\${AWS_SECRET_ACCESS_KEY:-}\"; echo host paths and environment absent"
run fetch "${MOAT[@]}" fetch
test "$(git for-each-ref --format='%(refname)' refs/moat/ | wc -l)" = 1
test "$(git rev-parse HEAD)" = "$HOST_HEAD"
test "$(hash)" = "$BEFORE"
say 'pass: fetch wrote one ref; host HEAD and host file tree stayed identical'
run take "${MOAT[@]}" take --json
node - "$WORK/take.out" <<'JS'
const report=JSON.parse(require('fs').readFileSync(process.argv[2]))
if(report.treeUntouched !== true || !report.reviewed.some(r=>r.path==='src/sum.js') || report.checks.ok !== true) process.exit(1)
JS
test "$(hash)" = "$BEFORE"
say 'pass: take --json reported the review and checks without changing the host tree'
run status "${MOAT[@]}" status --json
ROOTFS=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).envDir+"/rootfs")' "$WORK/status.out")
! grep -rlF "$MOAT_PI_TEST_KEY" "$ROOTFS/root/.pi" "$ROOTFS/work" "$ROOTFS/var/log/moat" > "$WORK/leaks.out"
node - "$ROOTFS/root/.pi/agent/models.json" <<'JS'
const p = JSON.parse(require('fs').readFileSync(process.argv[2])).providers.moat
if(p.apiKey !== '$MOAT_INJECTED_CREDENTIAL') process.exit(1)
JS
say 'pass: credential stayed environment-only, including Pi session files'
run marker "${MOAT[@]}" exec -- sh -c 'echo keep > /work/KEEP.txt; rm /usr/local/bin/pi'
run down "${MOAT[@]}" down
run repair "${MOAT[@]}" up --quiet --no-detect --credential-env MOAT_PI_TEST_KEY
run preserved "${MOAT[@]}" exec -- sh -c 'pi --version; cat /work/KEEP.txt'
grep -q '^keep$' "$WORK/preserved.out"
grep -q '^1.1.0$' "$WORK/preserved.out"
say 'pass: runtime repair and restart preserved sandbox work'
stub "$REPO/test/scripts/responses-escape.json"
run escapes "${MOAT[@]}" run --quiet --credential-env MOAT_PI_TEST_KEY 'Print the supplied text'
! grep -q $'\x1b' "$WORK/escapes.out" "$WORK/escapes.err"
grep -q 'and done' "$WORK/escapes.txt"
say 'pass: sandbox prose contained no terminal escape bytes'
printf '{"turns":[{"error":"Pi test unauthorized"}]}\n' > "$WORK/error.json"
stub "$WORK/error.json"
set +e
"${MOAT[@]}" run --json --credential-env MOAT_PI_TEST_KEY 'fail' > "$WORK/error.out" 2> "$WORK/error.err"
RC=$?
set -e
test "$RC" != 0
node - "$WORK/error.out" <<'JS'
const report=JSON.parse(require('fs').readFileSync(process.argv[2]))
if(report.code===0 || !report.errors.length) process.exit(1)
JS
say 'pass: a provider failure is nonzero even when Pi itself exits zero'
stub "$REPO/test/scripts/responses-acceptance-task.json"
set +e
"${MOAT[@]}" run --json --max-tokens 100 --credential-env MOAT_PI_TEST_KEY 'stop at the ceiling' > "$WORK/ceiling.out" 2> "$WORK/ceiling.err"
RC=$?
set -e
test "$RC" != 0
node - "$WORK/ceiling.out" "$RECORD" <<'JS'
const fs=require('fs'); const report=JSON.parse(fs.readFileSync(process.argv[2]))
if(!report.aborted || !report.aborted.includes('token ceiling')) process.exit(1)
if(fs.readFileSync(process.argv[3],'utf8').trim().split('\n').length!==1) process.exit(1)
JS
say 'pass: reported-usage ceiling stopped the agent before its next request'
printf '{"turns":[{"toolName":"moat_noise","tool":{}},{"toolName":"moat_noise","tool":{}},{"text":"long stream finished"}]}\n' > "$WORK/long.json"
stub "$WORK/long.json"
set +e
"${MOAT[@]}" run --json --max-tokens 20000 --credential-env MOAT_PI_TEST_KEY 'keep usage across a long stream' > "$WORK/long.out" 2> "$WORK/long.err"
RC=$?
set -e
test "$RC" != 0
node - "$WORK/long.out" <<'JS'
const report=JSON.parse(require('fs').readFileSync(process.argv[2]))
if(!report.aborted || report.usage.input+report.usage.cached+report.usage.output+report.usage.reasoning!==25920) process.exit(1)
JS
say 'pass: a stream beyond the raw-capture limit retained all three requests for its budget and footer'
run expiryDown "${MOAT[@]}" down
printf '{"turns":[{"delayMs":10000,"text":"the expired agent must not finish"}]}\n' > "$WORK/delay.json"
stub "$WORK/delay.json"
set +e
"${MOAT[@]}" run --json --credential-ttl 5s --credential-env MOAT_PI_TEST_KEY 'wait past the credential deadline' > "$WORK/expiry.out" 2> "$WORK/expiry.err"
RC=$?
set -e
test "$RC" != 0
node - "$WORK/expiry.out" "$RECORD" <<'JS'
const fs=require('fs'); const report=JSON.parse(fs.readFileSync(process.argv[2]))
if(report.code!==124 || report.credentialExpired!==true || report.timedOut || !report.errors.some(e=>e.includes('credential expired'))) process.exit(1)
if(fs.readFileSync(process.argv[3],'utf8').trim().split('\n').length!==1) process.exit(1)
JS
say 'pass: host-owned credential deadline stopped the ephemeral agent, not just the keepalive'
printf '{"turns":[{"tool":{"command":"printf chat-ran > /work/CHAT.txt"}},{"text":"chat finished"}]}\n' > "$WORK/chat.json"
stub "$WORK/chat.json"
run chat "${MOAT[@]}" run --quiet --wire-api chat --no-credential 'use chat completions'
run chatcheck "${MOAT[@]}" exec -- cat /work/CHAT.txt
grep -q 'chat-ran' "$WORK/chatcheck.out"
node - "$RECORD" <<'JS'
const fs=require('fs'); const rows=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse)
if(!rows.length || !rows.every(r=>r.url.endsWith('/chat/completions') && r.authorization===null)) process.exit(1)
JS
say 'pass: Chat Completions endpoint ran tools without an Authorization header'
if command -v ip >/dev/null; then
  HOST_IP=$(node -e 'const n=require("os").networkInterfaces(); console.log(Object.values(n).flat().find(a=>a.family==="IPv4"&&!a.internal)?.address||"")')
  test -n "$HOST_IP"
  printf '{"turns":[{"text":"Pi used the proxy"}]}\n' > "$WORK/proxy.json"
  stub "$WORK/proxy.json" 0.0.0.0
  run proxytask "${MOAT[@]}" run --quiet --egress filtered --egress-proxy --wire-api responses --base-url "http://$HOST_IP:$PORT/v1" --no-credential 'use the provider through the proxy'
  grep -q 'Pi used the proxy' "$WORK/proxytask.txt"
  run proxyroute "${MOAT[@]}" exec -- sh -c '! ip route | grep -q default; grep -qx "nameserver 127.0.0.1" /etc/resolv.conf'
  node - "$RECORD" <<'JS'
const rows=require('fs').readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse)
if(rows.length!==1 || rows[0].authorization!==null || !rows[0].url.endsWith('/responses')) process.exit(1)
JS
  say 'pass: Pi reached the provider through the proxy with no direct route or working resolver'
else
  say 'not run: Pi proxy task requires host ip(8); ordinary acceptance still ran'
fi
run finaldown "${MOAT[@]}" down
say 'acceptance (pi runtime): all criteria passed'
