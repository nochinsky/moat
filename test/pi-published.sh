#!/usr/bin/env bash
# Smoke the actual registry artifact, not a locally built tarball. Run only after publication.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$REPO/package.json').version")"
WORK="$(mktemp -d /tmp/moat-pi-published.XXXXXX)"
EVIDENCE="$REPO/test/evidence/pi-published.txt"
trap 'rm -rf "$WORK"' EXIT
export NO_COLOR=1
: > "$EVIDENCE"
printf 'published-package smoke: moat-sandbox@%s\n' "$VERSION" | tee -a "$EVIDENCE"
npm view "moat-sandbox@$VERSION" version dist.integrity dist.attestations --json > "$WORK/registry.json"
node - "$WORK/registry.json" "$VERSION" <<'JS' | tee -a "$EVIDENCE"
const fs=require('node:fs');const metadata=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))
if(metadata.version!==process.argv[3])throw Error('wrong registry version')
if(!metadata['dist.integrity']?.startsWith('sha512-'))throw Error('registry SRI missing')
if(!metadata['dist.attestations']?.provenance)throw Error('published provenance missing')
console.log(JSON.stringify(metadata,null,2))
JS
npm install --prefix "$WORK/install" --ignore-scripts --no-audit --no-fund "moat-sandbox@$VERSION" > "$WORK/install.log" 2>&1
npm audit signatures --prefix "$WORK/install" > "$WORK/signatures.log" 2>&1
tee -a "$EVIDENCE" < "$WORK/signatures.log"
ROOT="$WORK/install/node_modules/moat-sandbox"
BIN="$WORK/install/node_modules/.bin/moat"
"$BIN" version | tee -a "$EVIDENCE"
node --input-type=module - "$ROOT" "$VERSION" <<'JS' | tee -a "$EVIDENCE"
import fs from 'node:fs'
const root=process.argv[2];const pkg=JSON.parse(fs.readFileSync(root+'/package.json','utf8'))
if(pkg.version!==process.argv[3])throw Error('installed version mismatch')
for(const name of ['codex','claude','codex-prompt','model-catalog'])if(fs.existsSync(root+'/dist/bundle/'+name+'.js'))throw Error('retired adapter shipped')
const {piDependencyGraph}=await import(root+'/dist/sandbox/pi-install.js')
const graph=piDependencyGraph(fs.readFileSync(root+'/dist/bundle/pi-runtime/package-lock.json','utf8'))
if(!graph.length)throw Error('published Pi graph empty')
console.log(`published installer resolved ${graph.length} pinned packages; retired adapters absent`)
JS
"$BIN" --help > "$WORK/help.txt"
grep -q 'Pi' "$WORK/help.txt"
"$BIN" demo > "$WORK/demo.txt" 2>&1
sed "s|$HOME|/home/user|g" "$WORK/demo.txt" | tee -a "$EVIDENCE"
printf '\npi published: registry install, signatures/provenance, compiled assets and real sandbox demo passed\n' | tee -a "$EVIDENCE"
