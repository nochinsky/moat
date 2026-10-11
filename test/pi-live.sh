#!/usr/bin/env bash
# Bounded real-provider gate for the current Pi integration. No key value goes into argv/evidence.
# Set a provider-side spend cap too: streamed usage ceilings are not a universal spending limit.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${1:-deepseek-flash}"
if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo 'DEEPSEEK_API_KEY is unset; no paid request was made. Set it in the launching shell.' >&2
  exit 2
fi
WORK="$(mktemp -d /tmp/moat-pi-live.XXXXXX)"
PROJECT="$WORK/project"
EVIDENCE="$REPO/test/evidence/pi-live.txt"
MOAT=(node "$REPO/cmd/main.ts")
mkdir -p "$PROJECT/test"
cd "$PROJECT"
cleanup() {
  # Only this freshly created fixture, never --all or a shared envs directory.
  "${MOAT[@]}" destroy --yes --quiet >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
export NO_COLOR=1
fail() { printf 'pi live: FAILED — %s\n' "$1" | tee -a "$EVIDENCE" >&2; exit 1; }
: > "$EVIDENCE"
printf 'current Pi live smoke: deepseek/%s\nlimits: 180s per turn, 30000 reported tokens, $0.10 reported cost; provider-side cap still required\n' "$MODEL" >> "$EVIDENCE"
git init -q -b main
git config user.name 'Pi Live Fixture'
git config user.email 'pi-live@example.invalid'
cat > package.json <<'JSON'
{"name":"moat-pi-live-fixture","private":true,"type":"module","scripts":{"test":"node --test"}}
JSON
cat > sum.js <<'JS'
export const sum = (a, b) => a - b
JS
cat > test/sum.test.js <<'JS'
import test from 'node:test'
import assert from 'node:assert/strict'
import { sum } from '../sum.js'
test('adds positive numbers', () => assert.equal(sum(2, 3), 5))
test('adds negative numbers', () => assert.equal(sum(-4, -3), -7))
JS
git add -A && git commit -qm 'fixture: deliberately broken addition'
BASE="$(git rev-parse HEAD)"
BEFORE="$(sha256sum sum.js package.json test/sum.test.js)"
if npm test > "$WORK/before.txt" 2>&1; then fail 'fixture unexpectedly passed before the agent'; fi
printf 'pass: the unchanged fixture genuinely fails before the turn\n' >> "$EVIDENCE"
set +e
"${MOAT[@]}" run --model "$MODEL" --no-detect --no-follow --json \
  --credential-env DEEPSEEK_API_KEY --credential-ttl 5m \
  --timeout 180 --max-tokens 30000 --max-cost 0.10 \
  'Fix the bug in sum.js without changing the tests or package.json. Run npm test to verify both tests pass, then commit the fix on the current branch. Do not inspect credentials or change anything else.' \
  > "$WORK/turn.json" 2> "$WORK/turn.err"
CODE=$?
set -e
# Commit only a projection, not raw provider/tool messages or credential-bearing diagnostics.
node --input-type=module - "$REPO" "$WORK/turn.json" "$MODEL" "$CODE" <<'JS' >> "$EVIDENCE" || fail 'live provider/task/usage gate failed (details above)'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const [repo, file, model, exit] = process.argv.slice(2)
const { computeCost } = await import(pathToFileURL(repo + '/lib/pricing.ts'))
let report
try { report = JSON.parse(fs.readFileSync(file, 'utf8')) }
catch { console.log(`task exit: ${exit}; no valid Pi report`); process.exit(1) }
const key = process.env.DEEPSEEK_API_KEY
const scrub = text => String(text).replaceAll(key, '[redacted]').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
console.log(`task exit: ${exit}; reported code: ${report.code}`)
console.log(`models: ${(report.models ?? []).map(scrub).join(', ')}`)
console.log(`completed tools: ${(report.tools ?? []).filter(t => t.status === 'completed').length}`)
if (report.usage) {
  const u = report.usage
  console.log(`usage: ${JSON.stringify(u)}`)
  const cost = computeCost(model, {input:u.input,cacheRead:u.cached,output:u.output,reasoning:u.reasoning}, new Date())
  console.log(`reported cost: ${cost.known ? '$' + cost.usd.toFixed(6) : 'unknown'}`)
}
for (const error of report.errors ?? []) console.log(`error: ${scrub(error).slice(0, 2000)}`)
if (+exit !== 0 || report.code !== 0 || report.errors?.length || report.timedOut || report.aborted || report.credentialExpired) process.exit(1)
if (!(report.usage?.input + report.usage?.cached + report.usage?.output + report.usage?.reasoning > 0)) throw Error('no reported provider usage')
if (!report.models?.includes('deepseek/' + model)) throw Error('configured provider/model was not observed')
if (!report.tools?.some(t => t.status === 'completed')) throw Error('Pi executed no tools')
JS
"${MOAT[@]}" verify --timeout 30 --quiet > "$WORK/verify.txt" 2>&1 || fail 'fresh in-box project checks failed'
printf 'pass: a fresh in-box npm test verifies the fix independently\n' >> "$EVIDENCE"
"${MOAT[@]}" take --json --quiet --timeout 30 > "$WORK/review.json" 2> "$WORK/take.err" || fail 'take failed'
node - "$WORK/review.json" "$BASE" <<'JS' || fail 'the fix was not committed, fetched and reviewed'
const fs = require('node:fs')
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (!r.treeUntouched || !r.checks?.ok || r.sha === process.argv[3]) throw Error('commit/checks/host-preservation gate failed')
if (!r.reviewed?.some(row => row.path === 'sum.js' && !row.conflict)) throw Error('no reviewable sum.js fix')
if (r.reviewed.some(row => row.path !== 'sum.js')) throw Error('the agent changed more than requested')
JS
[ "$(git rev-parse HEAD)" = "$BASE" ] || fail 'host HEAD changed'
[ "$(sha256sum sum.js package.json test/sum.test.js)" = "$BEFORE" ] || fail 'host fixture files changed'
[ -z "$(git status --porcelain)" ] || fail 'host working tree changed'
printf 'pass: a new sandbox commit was fetched and reviewed; host HEAD and files remain unchanged\npi live: bounded real DeepSeek task, tools, reported usage, verification and read-only review passed\n' | tee -a "$EVIDENCE"
