#!/usr/bin/env bash
# A representative local Pi package + stdio MCP workflow, using the real CLI.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/pi-fixture.sh"
pi_fixture pi-customization
export HOST_ONLY_MCP_CANARY='host-only-workflow-canary-7128'
printf 'host-only file\n' > "$WORK/host-canary"
mkdir -p "$PROJECT/.pi" "$PROJECT/docs"
cp -a "$REPO/test/fixtures/pi-workflow" "$PROJECT/workflow"
cd "$PROJECT"
printf 'node_modules/\n' > .gitignore
printf '{"name":"mcp-workflow-project","type":"module","scripts":{"test":"node --test sum.test.js"}}\n' > package.json
printf 'export const sum = (a, b) => a - b\n' > sum.js
printf 'import {test} from "node:test"; import assert from "node:assert/strict"; import {sum} from "./sum.js"; test("adds", () => assert.equal(sum(1,2),3))\n' > sum.test.js
printf 'ARITHMETIC_MCP_SPEC_7128: sum must add a and b, including negative numbers.\n' > docs/arithmetic.md
node - "$WORK/host-canary" <<'JS'
const fs=require('fs')
fs.writeFileSync('.pi/mcp.json', JSON.stringify({mcpServers:{docs:{
  command:'node', args:['workflow/server.mjs',process.argv[2]], exposure:'direct', timeout:5,
  description:'Project arithmetic documentation, read-only tools and resources',
}}},null,2)+'\n')
JS
git init -q -b main
git config user.name 'Pi Workflow Test'; git config user.email 'workflow@moat.invalid'
git add -A; git commit -qm 'initial failing documentation workflow'
printf 'pre-existing user work\n' > notes.txt
BEFORE=$(pi_hash); HEAD_BEFORE=$(git rev-parse HEAD)
printf '{"turns":[{"toolName":"mcp__docs__search_docs","tool":{"pattern":"*.md"}},{"toolName":"read_mcp_resource","tool":{"server":"docs","uri":"docs://project/arithmetic"}},{"tool":{"command":"sed -i '\''s/a - b/a + b/'\'' sum.js && npm test && git add sum.js && git -c user.name=Agent -c user.email=agent@moat.invalid commit -qm '\''fix addition from project docs'\''"}},{"text":"Documentation-guided fix committed."}]}\n' > "$WORK/task.json"
pi_stub "$WORK/task.json"
pi_run up "${MOAT[@]}" up --quiet --no-detect --model mock-model --base-url "http://127.0.0.1:$PORT/v1" --no-credential
# Local Pi packages are not implicitly npm-installed; do both steps inside the
# box. Skip lifecycle scripts and automatic peer installation of Pi itself.
pi_run dependency "${MOAT[@]}" exec -- sh -c 'cd /work && timeout 60 npm install --prefix workflow --ignore-scripts --legacy-peer-deps --no-audit --no-fund'
pi_run package "${MOAT[@]}" exec -- sh -c 'cd /work && PI_OFFLINE=1 PI_TELEMETRY=0 pi install --local ./workflow --approve'
pi_run task "${MOAT[@]}" run --quiet --json --timeout 60 --max-tokens 50000 --no-credential '/skill:project-docs fix addition'
node --input-type=module - "$WORK/task.out" "$RECORD" <<'JS'
import fs from 'node:fs'; import assert from 'node:assert/strict'
const report=JSON.parse(fs.readFileSync(process.argv[2]))
assert.equal(report.code,0)
for(const kind of ['mcp__docs__search_docs','read_mcp_resource','bash']) {
  assert.ok(report.tools.some(t=>t.kind===kind && t.status==='completed' && t.exitCode===0),kind)
}
assert.ok(report.tools.some(t=>t.output.includes('ARITHMETIC_MCP_SPEC_7128')))
const rows=fs.readFileSync(process.argv[3],'utf8').trim().split('\n').map(JSON.parse)
assert.equal(rows.length,4)
assert.ok(rows.every(r=>r.authorization===null && r.tools.includes('mcp__docs__search_docs')))
assert.ok(rows[0].body.includes('WORKFLOW_SKILL_BODY_7128'),'explicit skill body reached the endpoint')
assert.ok(rows.some(r=>r.body.includes('ARITHMETIC_MCP_SPEC_7128')),'MCP result reached the endpoint')
JS
pi_run events "${MOAT[@]}" exec -- cat /opt/moat-mcp-events.jsonl
node --input-type=module - "$WORK/events.out" <<'JS'
import fs from 'node:fs'; import assert from 'node:assert/strict'
const events=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').filter(line=>!line.startsWith('[moat] boot:')).map(JSON.parse)
for(const event of ['initialized','search','resource','stdin closed']) assert.ok(events.some(e=>e.event===event),event)
assert.ok(events.every(e=>e.cwd==='/work' && e.uid===0 && e.sandbox==='1' && e.hostCanary===null && e.hostPathVisible===false))
assert.ok(events.some(e=>e.event==='search' && e.matches===1),'installed glob dependency was used')
JS
pi_run verify "${MOAT[@]}" verify --quiet --json
node - "$WORK/verify.out" <<'JS'
const report=JSON.parse(require('fs').readFileSync(process.argv[2])); if(!report.length||!report.every(r=>r.ok)) process.exit(1)
JS
pi_say 'pass: dependency installation, local Pi package, explicit skill, MCP search/resource and committed fix ran inside the box'
pi_run sessions "${MOAT[@]}" exec -- cat /opt/moat-workflow-sessions.jsonl
SESSION=$(node -e 'const r=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(line=>!line.startsWith("[moat] boot:")).map(JSON.parse); if(r.length!==1||r[0].mode!=="json"||r[0].hasUI||r[0].hostCanary!==null) process.exit(1); console.log(r[0].sessionFile)' "$WORK/sessions.out")
# Use Pi's CLI directly through moat exec for session options, not a host SDK or
# a competing moat session API. Keep the keyless header hook and offline settings.
printf '{"turns":[{"text":"Resumed documentation review."}]}\n' > "$WORK/resume.json"
pi_stub "$WORK/resume.json"
pi_run down "${MOAT[@]}" down --quiet
# The provider address changes because the stub used an OS-assigned port.
pi_run restart "${MOAT[@]}" up --quiet --no-detect --base-url "http://127.0.0.1:$PORT/v1" --no-credential
pi_run resume "${MOAT[@]}" exec -- sh -c 'cd /work && MOAT_MODEL=moat/mock-model PI_OFFLINE=1 PI_TELEMETRY=0 pi --approve --offline --extension /.moat/pi-auth.mjs --model moat/mock-model --thinking high --mode json --session "$1" -- "/docs-review addition" </dev/null' sh "$SESSION"
node --input-type=module - "$RECORD" <<'JS'
import fs from 'node:fs'; import assert from 'node:assert/strict'
const rows=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse)
assert.equal(rows.length,1)
assert.equal(rows[0].authorization,null)
assert.ok(rows[0].body.includes('WORKFLOW_PROMPT_EXPANDED_7128: review the addition change'))
assert.ok(rows[0].body.includes('Documentation-guided fix committed.'))
assert.ok(rows[0].body.includes('ARITHMETIC_MCP_SPEC_7128'))
JS
pi_run resumedSessions "${MOAT[@]}" exec -- cat /opt/moat-workflow-sessions.jsonl
node --input-type=module - "$WORK/resumedSessions.out" <<'JS'
import fs from 'node:fs'; import assert from 'node:assert/strict'
const sessions=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').filter(line=>!line.startsWith('[moat] boot:')).map(JSON.parse)
assert.equal(sessions.length,2)
assert.equal(sessions[0].sessionId,sessions[1].sessionId)
assert.equal(sessions[0].sessionFile,sessions[1].sessionFile)
assert.ok(sessions[1].entries>sessions[0].entries)
JS
pi_say 'pass: down/up retained the package and session; explicit Pi resume kept context and expanded a package prompt template'
printf '{"turns":[{"toolName":"mcp__docs__search_docs","tool":{"pattern":"private*"}},{"text":"Private search refused without a headless approval dialog."}]}\n' > "$WORK/approval.json"
pi_stub "$WORK/approval.json"
# Update remembered endpoint without deleting or syncing the installed workflow.
pi_run approval "${MOAT[@]}" run --quiet --json --timeout 15 --base-url "http://127.0.0.1:$PORT/v1" --no-credential 'try the approval-requiring private search'
node --input-type=module - "$WORK/approval.out" <<'JS'
import fs from 'node:fs'; import assert from 'node:assert/strict'
const report=JSON.parse(fs.readFileSync(process.argv[2]))
assert.equal(report.timedOut,false)
assert.ok(report.tools.some(t=>t.kind==='mcp__docs__search_docs' && t.exitCode!==0 && t.output.includes('no UI in headless mode')))
JS
pi_run guardedEvents "${MOAT[@]}" exec -- cat /opt/moat-mcp-events.jsonl
! grep -q 'private\*' "$WORK/guardedEvents.out"
pi_run processCheck "${MOAT[@]}" exec -- sh -c '! ps -eo args | grep "[n]ode workflow/server.mjs"'
pi_say 'pass: the extension denied a UI-dependent headless call before MCP dispatch; the stdio server was reaped'
pi_run take "${MOAT[@]}" take --quiet --json
node - "$WORK/take.out" <<'JS'
const r=JSON.parse(require('fs').readFileSync(process.argv[2])); if(r.treeUntouched!==true||r.checks.ok!==true||!r.reviewed.some(x=>x.path==='sum.js')) process.exit(1)
JS
test "$(pi_hash)" = "$BEFORE"; test "$(git rev-parse HEAD)" = "$HEAD_BEFORE"
test ! -e workflow/node_modules; test ! -e /opt/moat-mcp-events.jsonl
pi_say 'pass: read-only fetch/review left host files and HEAD unchanged; dependencies and MCP witnesses never appeared on the host'
pi_say 'pi-customization: all criteria passed (local package, stdio MCP, skills/prompts, resume, headless policy)'
