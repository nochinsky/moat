#!/usr/bin/env bash
# Installed-tarball smoke: compiled assets, a valid pinned graph and an actual in-box demo.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d /tmp/moat-pi-package.XXXXXX)"
EVIDENCE="$REPO/test/evidence/pi-package.txt"
trap 'rm -rf "$WORK"' EXIT
cd "$REPO"
export NO_COLOR=1
: > "$EVIDENCE"
# This generated stale file must not survive a rebuild after a runtime adapter is deleted.
mkdir -p dist/bundle
printf '// retired build output\n' > dist/bundle/codex.js
npm pack --json --pack-destination "$WORK" > "$WORK/pack.json" 2> "$WORK/pack.err"
cat "$WORK/pack.err" >> "$EVIDENCE"
ARCHIVE="$(node - "$WORK/pack.json" <<'JS'
const fs=require('fs'); const text=fs.readFileSync(process.argv[2],'utf8')
const p=JSON.parse(text.slice(text.indexOf('[')))[0]
for(const name of ['dist/cmd/main.js','dist/bundle/pi-runtime/package.json','dist/bundle/pi-runtime/package-lock.json','CHANGELOG.md']) {
  if(!p.files.some(f=>f.path===name)) throw Error('not shipped: '+name)
}
if(p.files.some(f=>/dist\/bundle\/(codex|claude|model-catalog|codex-prompt)\.js/.test(f.path))) throw Error('retired adapter shipped')
console.log(p.filename)
JS
)"
npm install --prefix "$WORK/install" --ignore-scripts --no-audit --no-fund "$WORK/$ARCHIVE" > "$WORK/install.log" 2>&1
BIN="$WORK/install/node_modules/.bin/moat"
"$BIN" version | tee -a "$EVIDENCE"
"$BIN" --help > "$WORK/help.txt"
grep -q 'Pi' "$WORK/help.txt"
node --input-type=module - "$WORK/install/node_modules/moat-sandbox" <<'JS' | tee -a "$EVIDENCE"
import fs from 'node:fs'
const root=process.argv[2]
const {piDependencyGraph}=await import(root+'/dist/sandbox/pi-install.js')
const graph=piDependencyGraph(fs.readFileSync(root+'/dist/bundle/pi-runtime/package-lock.json','utf8'))
if(!graph.length) throw Error('empty packaged Pi graph')
console.log(`packaged installer resolved ${graph.length} digest-pinned Linux packages`)
JS
"$BIN" demo > "$WORK/demo.txt" 2>&1
sed "s|$HOME|/home/user|g" "$WORK/demo.txt" | tee -a "$EVIDENCE"
printf '\npi package: installed compiled CLI, pinned lock assets, stale-output cleanup and real sandbox demo passed\n' | tee -a "$EVIDENCE"
