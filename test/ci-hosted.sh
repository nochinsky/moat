#!/usr/bin/env bash
# Record a completed hosted-CI run, checking uploaded suite verdicts rather than green job labels alone.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="${1:?usage: bash test/ci-hosted.sh <completed CI run id>}"
WORK="$(mktemp -d /tmp/moat-hosted-ci.XXXXXX)"
EVIDENCE="$REPO/test/evidence/ci-hosted.txt"
trap 'rm -rf "$WORK"' EXIT
gh run view "$RUN" --repo nochinsky/moat --json databaseId,headSha,status,conclusion,url,jobs > "$WORK/run.json"
for os in ubuntu-22.04 ubuntu-24.04; do
  gh run download "$RUN" --repo nochinsky/moat --name "evidence-$os" --dir "$WORK/$os"
done
node - "$WORK" <<'JS' > "$EVIDENCE"
const fs=require('node:fs');const path=require('node:path');const root=process.argv[2]
const run=JSON.parse(fs.readFileSync(path.join(root,'run.json'),'utf8'))
if(run.status!=='completed'||run.conclusion!=='success')throw Error('CI run did not pass')
console.log(`hosted CI run: ${run.databaseId}`)
console.log(`source commit: ${run.headSha}`)
console.log(`URL: ${run.url}`)
for(const os of ['ubuntu-22.04','ubuntu-24.04']){
 const job=run.jobs.find(j=>j.name===`sandbox end-to-end (${os})`)
 if(job?.conclusion!=='success')throw Error('sandbox job did not pass: '+os)
 for(const name of ['acceptance suite, keyless (Pi against the compatible API stub)','secondary suite (snapshots, apply, credential expiry)','egress suite (own namespace, slirp datapath, closed loopback, allowlist)']){
  if(!job.steps.some(s=>s.name===name&&s.conclusion==='success'))throw Error('suite was skipped or failed: '+name)
 }
 const read=name=>fs.readFileSync(path.join(root,os,name),'utf8')
 const acceptance=read('pi-summary.txt').match(/acceptance \(pi runtime\): all criteria passed/)
 const extras=read('extras.txt').match(/^checks passed: \d+, failed: 0$/m)
 const egress=read('egress.txt').match(/^egress checks passed.*$/m)
 if(!acceptance||!extras||!egress)throw Error('uploaded suite evidence lacks passing verdicts: '+os)
 console.log(`${os}: ${acceptance[0]}; ${extras[0]}; ${egress[0]}`)
}
console.log('ci hosted: real Pi acceptance, extras and egress passed on ubuntu-22.04 and ubuntu-24.04; uploaded captures checked')
JS
tee /dev/stderr < "$EVIDENCE"
