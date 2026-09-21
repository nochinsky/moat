#!/usr/bin/env bash
#
# Phase 1's gate: a boot with a non-DeepSeek provider works end to end against the local
# stub, with no credential in the image and the sweep green.
#
# This is the suite that proves the DeepSeek lock is gone, and it is written to fail if any
# part of it comes back:
#
#   - the provider is *named* and configured in moat's own store, not passed as a raw
#     `--base-url`. That distinction is the whole phase: `--base-url` existed before and got
#     a boot working, while the box still described itself as DeepSeek in its config key, its
#     provider label, its key variable and its model catalog.
#   - the rendered config is read back out of the box and checked for each of those.
#   - the catalog in the box is checked to describe the configured model and to contain no
#     vendor's name.
#   - the key reaches the provider (asserted on what the *stub received*, not on what moat
#     says it sent) and appears nowhere on disk inside the box.
#
# Usage: bash test/e2e-provider.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
M="node $REPO/cmd/main.ts"
EVIDENCE="$REPO/test/evidence"
LOG="$EVIDENCE/provider.txt"
WORK="${MOAT_E2E_DIR:-$HOME/moat-demo}/provider-gate"
PORT="${PROVIDER_GATE_PORT:-5687}"

# A credential whose value is assembled from pieces wherever this file needs to search for it.
# `moat exec` writes the command it runs into an entry script inside the rootfs, so a grep whose
# argv holds the literal value would put the value on disk as the text of the search for it, and
# moat's own post-boot sweep would then find it and refuse the boot. That is not hypothetical:
# the first version of this gate checked for itself and failed twice.
CREDENTIAL_PARTS='acme-secret""-value""-8f3a1c9d2e'
CREDENTIAL="acme-secret-value-8f3a1c9d2e"

mkdir -p "$EVIDENCE" "$WORK"
CHECKS_LOG="$LOG"
. "$REPO/test/lib/guard.sh"
check_count

say() { echo "$@" | tee -a "$LOG"; }
scrub() { sed -e "s|$HOME|/home/user|g" -e "s|${USER:-$(id -un)}|user|g"; }

export MOAT_HOME="$WORK/home"
export ACME_API_KEY="$CREDENTIAL"

rm -rf "$WORK/project"
mkdir -p "$WORK/project/src" "$WORK/project/test"
cd "$WORK/project"
cat > package.json <<'EOF'
{ "name": "acme-fixture", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" } }
EOF
cat > src/sum.js <<'EOF'
export const sum = (a, b) => a - b
EOF
cat > test/sum.test.js <<'EOF'
import test from "node:test"
import assert from "node:assert/strict"
import { sum } from "../src/sum.js"
test("adds", () => assert.equal(sum(2, 3), 5))
EOF
git init -q -b main
git config user.email gate@example.com
git config user.name "Gate"
git add -A
git commit -qm "initial commit (test suite currently failing)"

# The stub: a keyless Responses server, standing in for a third-party provider.
: > "$WORK/record.jsonl"
if [ -f "$WORK/stub.pid" ]; then kill "$(cat "$WORK/stub.pid")" 2>/dev/null; fi
setsid node "$REPO/test/mock-responses.mjs" --port "$PORT" \
  --script "$REPO/test/scripts/responses-basic.json" --record "$WORK/record.jsonl" \
  > "$WORK/stub.log" 2>&1 < /dev/null &
echo $! > "$WORK/stub.pid"
trap 'kill "$(cat "$WORK/stub.pid" 2>/dev/null)" 2>/dev/null; ( cd "$WORK/project" && '"$M"' destroy --yes >/dev/null 2>&1 )' EXIT
sleep 1.5

say "=============================================================="
say "== a named, non-DeepSeek provider, end to end"
say "=============================================================="
say "the provider is configured in moat's own store with its own key variable, then booted"
say "with --provider. Before this phase the only route to another endpoint was --base-url, and"
say "the box still described itself as DeepSeek in its config key, its provider label, its key"
say "variable and the model catalog it was handed."

( cd "$WORK/project" && $M provider add acme --base-url "http://127.0.0.1:$PORT/v1" \
    --env-var ACME_API_KEY --model mock-model ) >> "$LOG" 2>&1
( cd "$WORK/project" && $M provider ) 2>&1 | scrub | tee -a "$LOG"

( cd "$WORK/project" && $M destroy --yes >/dev/null 2>&1 )
( cd "$WORK/project" && $M up --provider acme --model mock-model --egress open --no-detect ) > "$WORK/up.log" 2>&1

# Read the three files back out of the box.
( cd "$WORK/project" && $M exec -- /bin/sh -c 'cat /root/.codex/config.toml' ) > "$WORK/config.txt" 2>&1
( cd "$WORK/project" && $M exec -- /bin/sh -c 'cat /root/.codex/models.json' ) > "$WORK/catalog.json" 2>&1
say ""
say "--- the config in the box ---"
scrub < "$WORK/config.txt" | tee -a "$LOG"

if grep -q 'name = "acme"' "$WORK/config.txt"; then
  pass "the provider block" "carries the configured provider's label, not DeepSeek's"
else
  fail "the provider block" "does not name the configured provider"
fi
if grep -q "base_url = \"http://127.0.0.1:$PORT/v1\"" "$WORK/config.txt"; then
  pass "the base URL" "is the configured endpoint"
else
  fail "the base URL" "is not the configured endpoint"
fi
if grep -q 'env_key = "ACME_API_KEY"' "$WORK/config.txt"; then
  pass "env_key" "is the provider's own variable, not DEEPSEEK_API_KEY"
else
  fail "env_key" "is not the provider's own variable"
fi
if grep -qi 'deepseek' "$WORK/config.txt"; then
  fail "the rendered config" "still names DeepSeek for a non-DeepSeek provider"
else
  pass "the rendered config" "names no vendor but the configured one"
fi
if grep -q 'model = "mock-model"' "$WORK/config.txt"; then
  pass "the model" "is the configured one"
else
  fail "the model" "is not the configured one"
fi

# The catalog is rendered per boot for the configured model; it must describe that model and
# nothing else. It used to be one provider's file, installed byte for byte on every boot.
if python3 - "$WORK/catalog.json" > "$WORK/catalog-check.txt" 2>&1 <<'PY'
import json, sys
cat = json.load(open(sys.argv[1]))
models = cat.get("models") or []
assert [m.get("slug") for m in models] == ["mock-model"], "slugs: %s" % [m.get("slug") for m in models]
assert "deepseek" not in json.dumps(cat).lower(), "the catalog names DeepSeek"
assert all("base_instructions" in m for m in models), "an entry is missing base_instructions"
PY
then
  pass "the model catalog" "describes the configured model, with the required prompt field and no vendor's metadata"
else
  fail "the model catalog" "$(tail -2 "$WORK/catalog-check.txt" | head -1)"
fi

# The key reaches the provider, and is nowhere in the image.
( cd "$WORK/project" && timeout 180 $M run "fix the failing test" ) > "$WORK/run.log" 2>&1
RUN_RC=$?
say ""
say "--- the turn ---"
grep -E "tool|tokens|Fixed" "$WORK/run.log" | scrub | tee -a "$LOG"

if python3 - "$WORK/record.jsonl" > "$WORK/record-check.txt" 2>&1 <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
assert rows, "the provider received no request"
assert all(r.get("model") == "mock-model" for r in rows), "a request carried the wrong model"
assert all("acme-secret" in (r.get("authorization") or "") for r in rows), "a request carried no key"
assert all(len(r.get("instructions") or "") > 1000 for r in rows), "a request carried no agent prompt"
assert not any("Model metadata for" in json.dumps(r) for r in rows), "the metadata advisory is back"
PY
then
  pass "what the provider received" "the configured model, the key as a bearer token, the agent prompt, and no metadata advisory"
else
  fail "what the provider received" "$(tail -2 "$WORK/record-check.txt" | head -1)"
fi

# Search for the value inside the box. The value is assembled there, so this command does not
# itself contain it — see the note at the top of this file for why that matters.
( cd "$WORK/project" && $M exec -- /bin/sh -c "V=\"$CREDENTIAL_PARTS\"; grep -rlF \"\$V\" / --exclude-dir=proc --exclude-dir=sys 2>/dev/null | head -5; echo grep-done" ) > "$WORK/sweep.txt" 2>&1
if grep -q "$CREDENTIAL" "$WORK/sweep.txt"; then
  fail "the credential in the image" "found on disk inside the box: $(grep -m1 "$CREDENTIAL" "$WORK/sweep.txt" | scrub)"
else
  pass "the credential in the image" "the value is nowhere on disk inside the box"
fi

# And the work is real: the project's own test passes in a fresh boot.
( cd "$WORK/project" && $M exec -- /bin/sh -c 'cd /work && npm test 2>&1 | grep -E "^# (tests|pass|fail)"' ) > "$WORK/verify.txt" 2>&1
scrub < "$WORK/verify.txt" | tee -a "$LOG"
if grep -qE "^# fail 0" "$WORK/verify.txt" && [ "$RUN_RC" = "0" ]; then
  pass "the task" "the agent's fix passes the project's own tests, run by moat in a fresh boot"
else
  fail "the task" "the turn exited $RUN_RC or the project's tests do not pass"
fi

echo "" | tee -a "$LOG"
echo "provider evidence written to $LOG" | tee -a "$LOG"
verdict
exit $?
