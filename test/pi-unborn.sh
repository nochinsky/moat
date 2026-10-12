#!/usr/bin/env bash
# A first-commit project travels into the real box, keeping an empty baseline.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/pi-fixture.sh"
pi_fixture pi-unborn
cd "$PROJECT"
git init -q -b main
printf '{"name":"unborn-pi-project","type":"module","scripts":{"test":"node --test sum.test.js"}}\n' > package.json
printf 'export const sum = (a, b) => a - b\n' > sum.js
printf 'import {test} from "node:test"; import assert from "node:assert/strict"; import {sum} from "./sum.js"; test("adds", () => assert.equal(sum(1,2),3))\n' > sum.test.js
printf 'my initial staged note\n' > mine.txt
git add -A
printf 'my current note, edited after staging\n' > mine.txt
printf 'my untracked note\n' > untracked.txt
printf '\000\377\200\r\n' > binary.bin
printf '#!/bin/sh\nprintf executable-ok\\n\n' > executable.sh
chmod 755 executable.sh
ln -s mine.txt link
BEFORE=$(pi_hash)
INDEX_BEFORE=$(sha256sum .git/index | cut -d' ' -f1)
STATUS_BEFORE=$(git status --porcelain -z | sha256sum | cut -d' ' -f1)
printf '{"turns":[{"tool":{"command":"test -f untracked.txt && test -L link && test -x executable.sh && grep -q '\''edited after staging'\'' mine.txt && sed -i '\''s/a - b/a + b/'\'' sum.js && printf '\''agent competing note\\n'\'' > mine.txt && printf '\''separate agent addition\\n'\'' > agent.txt && npm test && git add -A && git -c user.name=Agent -c user.email=agent@moat.invalid commit -qm '\''first commit inside the box'\''"}},{"text":"First sandbox commit created."}]}\n' > "$WORK/task.json"
pi_stub "$WORK/task.json"
pi_run up "${MOAT[@]}" up --quiet --json --no-detect --model mock-model --base-url "http://127.0.0.1:$PORT/v1" --no-credential
node - "$WORK/up.out" <<'JS'
const assert=require('node:assert/strict'); const r=JSON.parse(require('fs').readFileSync(process.argv[2])); assert.equal(r.copyIn.head,null); assert.equal(r.copyIn.branch,'main'); assert.equal(r.copyIn.dirty,true); assert.ok(r.copyIn.files>0)
JS
pi_run baseline "${MOAT[@]}" exec -- sh -c 'test -z "$(git -C /work ls-tree -r --name-only refs/moat/baseline)" && cmp /work/mine.txt /work/link && test -x /work/executable.sh && printf "\\000\\377\\200\\r\\n" | cmp - /work/binary.bin'
pi_say 'pass: staged and untracked working files, symlink and executable reached /work; unborn metadata and empty baseline are truthful'
pi_run task "${MOAT[@]}" run --quiet --json --timeout 30 --max-tokens 20000 --no-credential 'fix addition, make a competing note edit and commit inside the box'
node - "$WORK/task.out" "$RECORD" <<'JS'
const fs=require('fs'), assert=require('node:assert/strict'); const r=JSON.parse(fs.readFileSync(process.argv[2])); assert.equal(r.code,0); assert.ok(r.tools.some(t=>t.kind==='bash'&&t.exitCode===0)); const rows=fs.readFileSync(process.argv[3],'utf8').trim().split('\n').map(JSON.parse); assert.equal(rows.length,2); assert.ok(rows.every(r=>r.authorization===null))
JS
pi_run take "${MOAT[@]}" take --quiet --json
node - "$WORK/take.out" <<'JS'
const assert=require('node:assert/strict'); const r=JSON.parse(require('fs').readFileSync(process.argv[2])); assert.equal(r.treeUntouched,true); assert.equal(r.checks.ok,true); assert.ok(r.reviewed.some(x=>x.path==='mine.txt'&&x.verdict==='conflict')); assert.ok(r.reviewed.some(x=>x.path==='agent.txt'&&x.verdict==='agent'))
JS
test "$(pi_hash)" = "$BEFORE"
test "$(sha256sum .git/index | cut -d' ' -f1)" = "$INDEX_BEFORE"
test "$(git status --porcelain -z | sha256sum | cut -d' ' -f1)" = "$STATUS_BEFORE"
! git rev-parse --verify --quiet HEAD >/dev/null
pi_say 'pass: Pi made its first commit and checks passed; review identified competing additions without touching host files, index or unborn HEAD'
pi_say 'pi-unborn: all criteria passed (working copy, empty baseline, real task, explicit read-only review)'
