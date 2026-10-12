#!/usr/bin/env bash
# Check completed hosted jobs AND their uploaded Pi compatibility captures.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="${1:?usage: bash test/pi-compatibility-hosted.sh <completed CI run id>}"
WORK="$(mktemp -d /tmp/moat-pi-compat-hosted.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
EVIDENCE="$REPO/test/evidence/pi-compatibility-hosted.txt"
gh run view "$RUN" --repo nochinsky/moat --json databaseId,headSha,status,conclusion,url,jobs > "$WORK/run.json"
for os in ubuntu-22.04 ubuntu-24.04; do
  gh run download "$RUN" --repo nochinsky/moat --name "evidence-$os" --dir "$WORK/$os"
done
node - "$WORK" <<'JS' > "$WORK/checked.txt"
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict')
const root=process.argv[2], run=JSON.parse(fs.readFileSync(path.join(root,'run.json')))
assert.equal(run.status,'completed'); assert.equal(run.conclusion,'success')
console.log(`hosted compatibility run: ${run.databaseId}\nsource commit: ${run.headSha}\nURL: ${run.url}`)
for(const os of ['ubuntu-22.04','ubuntu-24.04']) {
 const job=run.jobs.find(j=>j.name===`sandbox end-to-end (${os})`)
 assert.equal(job?.conclusion,'success',os)
 for(const name of ['unborn Git copy-in (real Pi task and read-only review)','Pi customization (package, MCP, resume and headless policy)','Pi container acceptance (task, limits and cleanup)']) {
  assert.ok(job.steps.some(s=>s.name===name&&s.conclusion==='success'),`${os}: ${name} was skipped or failed`)
 }
 console.log(`--- ${os}`)
 for(const suite of ['pi-unborn','pi-customization','pi-container']) {
  const capture=fs.readFileSync(path.join(root,os,`${suite}.txt`),'utf8')
  assert.match(capture,new RegExp(`^${suite}: all criteria passed`, 'm'))
  assert.doesNotMatch(capture,/FAILED|SKIPPED/)
  console.log(capture.trim())
 }
}
console.log('pi compatibility hosted: unborn copy-in, MCP/package workflow and real Pi container task/limits/cleanup passed on ubuntu-22.04 and ubuntu-24.04; uploaded captures checked')
JS
# Never erase a previously verified capture when a download/job/verdict fails.
cp "$WORK/checked.txt" "$EVIDENCE"
cat "$EVIDENCE"
