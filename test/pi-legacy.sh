#!/usr/bin/env bash
# Upgrade an actual published Codex rootfs/state to Pi, not a mocked wrapper deletion.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d /tmp/moat-pi-legacy.XXXXXX)"
CACHE_HOME="${MOAT_HOME:-$HOME/.moat}"
export MOAT_HOME="$WORK/home" NO_COLOR=1
mkdir -p "$MOAT_HOME" "$CACHE_HOME/cache" "$WORK/source" "$WORK/project"
ln -s "$CACHE_HOME/cache" "$MOAT_HOME/cache"
PROJECT="$WORK/project"
EVIDENCE="$REPO/test/evidence/pi-legacy.txt"
MOAT=(node "$REPO/cmd/main.ts")
cleanup() { (cd "$PROJECT" && "${MOAT[@]}" destroy --quiet --yes) >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
: > "$EVIDENCE"
run() {
  printf '\n--- %s\n' "$1" | tee -a "$EVIDENCE"; shift
  "$@" > "$WORK/out" 2>&1
  sed "s|$HOME|/home/user|g" "$WORK/out" | tee -a "$EVIDENCE"
}
git -C "$REPO" archive v0.0.3 --output="$WORK/old-source.tar"
tar -xf "$WORK/old-source.tar" -C "$WORK/source"
cd "$PROJECT"
git init -q -b main
git config user.name 'Pi Legacy'; git config user.email 'pi-legacy@moat.invalid'
printf 'host baseline\n' > original.txt
git add -A; git commit -qm 'host baseline'
run 'published 0.0.3 boot' node "$WORK/source/cmd/main.ts" up --quiet --no-detect --no-credential --model mock-model --base-url http://127.0.0.1:5597/v1
run 'legacy binary and sandbox work' node "$WORK/source/cmd/main.ts" exec -- sh -c 'codex --version; echo legacy-work > /work/KEEP.txt; echo installed-state > /opt/legacy-package-marker; git -C /work add KEEP.txt; git -C /work commit -qm legacy-work; git -C /work branch experiment'
node "$WORK/source/cmd/main.ts" status --json > "$WORK/status.json"
ENV_DIR="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).envDir)' "$WORK/status.json")"
boxref() {
  node --input-type=module - "$REPO" "$ENV_DIR/rootfs/work" "$1" <<'JS'
const {sandboxGit}=await import(process.argv[2] + '/lib/git.ts')
process.stdout.write((await sandboxGit(process.argv[3], ['rev-parse', process.argv[4]])).stdout.trim())
JS
}
OLD_COMMIT="$(boxref refs/heads/experiment)"
OLD_BASELINE="$(boxref refs/moat/baseline)"
run 'stop old box' node "$WORK/source/cmd/main.ts" down --quiet
run 'upgrade without fresh' "${MOAT[@]}" up --quiet --no-detect --no-credential
run 'Pi and preserved work/packages/refs' "${MOAT[@]}" exec -- sh -c 'pi --version; node --version; cat /work/KEEP.txt /opt/legacy-package-marker; git -C /work rev-parse refs/heads/experiment'
grep -qx '1.1.0' "$WORK/out"
grep -qx 'legacy-work' "$WORK/out"
grep -qx 'installed-state' "$WORK/out"
grep -qx "$OLD_COMMIT" "$WORK/out"
test "$OLD_BASELINE" = "$(boxref refs/moat/baseline)"
test ! -e "$PROJECT/KEEP.txt"
node - "$ENV_DIR/state.json" <<'JS'
const state=JSON.parse(require('fs').readFileSync(process.argv[2]))
if(state.agentVersion !== '1.1.0' || 'runtime' in state || state.wireApi !== 'responses') process.exit(1)
JS
printf '\npi legacy: published Codex environment upgraded in place; work, refs, baseline and installed state preserved\n' | tee -a "$EVIDENCE"
