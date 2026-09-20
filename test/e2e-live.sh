#!/usr/bin/env bash
#
# moat verification, part 3: a REAL model, driving a REAL task.
#
# The other two suites use a deterministic local stub so they need no API key and
# produce identical results every time. This one is the opposite: it spends real
# tokens against a real provider to prove the thing the stub cannot, that a
# frontier coding model, given the environment moat builds, actually does the
# work, and that the claims it makes are true.
#
# It also verifies the agent's work independently, because "the agent said the
# tests pass" is not evidence.
#
# Usage:
#   DEEPSEEK_API_KEY=sk-... bash test/e2e-live.sh
#   DEEPSEEK_API_KEY=...    bash test/e2e-live.sh deepseek-v4-flash   # another model
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOAT="node $REPO/cmd/main.ts"
MODEL="${1:-deepseek-flash}"   # the default; pass another id to test it
PROFILE="${PROFILE:-node}"
WORK="${MOAT_E2E_DIR:-$HOME/moat-demo}"
PROJECT="$WORK/live-project"
EVIDENCE="$REPO/test/evidence"
TIMEOUT="${LIVE_TIMEOUT:-1800}"

KEYVAR=DEEPSEEK_API_KEY

if [ -z "${!KEYVAR:-}" ]; then
  echo "no $KEYVAR in the environment."
  echo "This suite spends real tokens against a real provider; it will not run without a key."
  echo "  $KEYVAR=... bash test/e2e-live.sh $MODEL"
  exit 2
fi

mkdir -p "$EVIDENCE"
LOG="$EVIDENCE/live-session.txt"
: > "$LOG"

say() { echo "$@" | tee -a "$LOG"; }
run() {
  echo "" | tee -a "$LOG"
  echo "--- \$ $*" | tee -a "$LOG"
  "$@" >> "$LOG" 2>&1
  echo "--- exit $?" | tee -a "$LOG"
}

# The failure accumulator. This suite had none: it was a recorder, not a test. It
# wrote evidence and printed it, every line informational, and exited 0 whatever
# the live model had done -- so nothing downstream could gate on a real provider
# run. The machinery is shared with e2e-extras.sh (test/lib/guard.sh) and its
# behavior is proven by `bash test/fail-guard.sh`.
EVIDENCE="$EVIDENCE" CHECKS_LOG="$LOG" . "$REPO/test/lib/guard.sh"
check_count

say "=============================================================="
say "== live model run: deepseek / $MODEL"
say "== key: \$$KEYVAR (value never printed, never written to disk)"
say "=============================================================="

# ---------------------------------------------------------------------------
say ""
say "== 1. a fixture that genuinely fails"
# ---------------------------------------------------------------------------
rm -rf "$PROJECT"
mkdir -p "$PROJECT/src" "$PROJECT/test"
cd "$PROJECT"
git init -q -b main
git config user.email demo@example.com
git config user.name "Demo User"

cat > package.json <<'EOF'
{
  "name": "slugkit",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" },
  "dependencies": { "picocolors": "^1.1.1" }
}
EOF

cat > src/slugify.js <<'EOF'
// BUG (deliberate): only handles the simplest case. Make the test suite pass.
export function slugify(input) {
  return input.toLowerCase().replace(/ /g, "-")
}
EOF

cat > src/cli.js <<'EOF'
import pc from "picocolors"
import { slugify } from "./slugify.js"
if (process.argv.includes("--version")) { console.log("slugkit 1.0.0"); process.exit(0) }
const input = process.argv.slice(2).join(" ")
if (!input) { console.error(pc.red("usage: slugkit <title>")); process.exit(1) }
console.log(pc.green(slugify(input)))
EOF

cat > test/slugify.test.js <<'EOF'
import test from "node:test"
import assert from "node:assert/strict"
import { slugify } from "../src/slugify.js"

test("lowercases", () => assert.equal(slugify("Hello"), "hello"))
test("collapses runs of whitespace", () => assert.equal(slugify("Hello   World"), "hello-world"))
test("trims", () => assert.equal(slugify("  Hello World  "), "hello-world"))
test("drops punctuation", () => assert.equal(slugify("Hello, World!"), "hello-world"))
test("no trailing hyphen", () => assert.equal(slugify("Hello World --- "), "hello-world"))
test("transliterates accents", () => assert.equal(slugify("Crème Brûlée"), "creme-brulee"))
EOF

git add -A
git commit -qm "slugkit: initial commit (test suite currently failing)"
say "fixture: $(git rev-parse --short HEAD), $(ls src test | tr '\n' ' ')"
say "before: $(npm test 2>&1 | grep -E '^ℹ (pass|fail)' | tr '\n' ' ')"
# The fixture has to be broken before the agent is asked to fix it, or a green
# suite afterwards proves nothing about the turn. This is the control, and it is
# the first check for exactly that reason.
if npm test >/dev/null 2>&1; then
  fail "the fixture starts broken" "the test suite passed before the agent touched it"
else
  pass "the fixture starts broken" "npm test fails before the turn, as the task assumes"
fi

# ---------------------------------------------------------------------------
say ""
say "== 2. boot with the real provider"
# ---------------------------------------------------------------------------
run $MOAT destroy --yes
run $MOAT up --model "$MODEL" --profile "$PROFILE" --credential-env "$KEYVAR"

# ---------------------------------------------------------------------------
say ""
say "== 3. the agent does the work"
# ---------------------------------------------------------------------------
say "the turn streams Codex's own events; --show-output adds each tool's output as it runs"
run timeout "$TIMEOUT" $MOAT run --show-output \
  "npm test is failing. Run it, find the bug in src/slugify.js, and fix it so the whole suite passes. Then run npm install and verify the CLI works end to end. Commit everything to the branch you are on, and report the final test output."

# ---------------------------------------------------------------------------
say ""
say "== 4. verify the agent's claims independently"
# ---------------------------------------------------------------------------
say "(the agent's own report is above; this is moat checking it, not taking its word)"
say ""
say "--- the code it actually wrote ---"
$MOAT exec -- /bin/sh -c 'cat /work/src/slugify.js' 2>&1 | tee -a "$LOG"
say ""
say "--- a fresh test run, started by moat ---"
FRESH_TESTS=$($MOAT exec -- /bin/sh -c 'cd /work && npm test 2>&1 | grep -E "^(#|ℹ) (tests|pass|fail)"' 2>&1)
printf '%s\n' "$FRESH_TESTS" | tee -a "$LOG"
say ""
say "--- the CLI, end to end ---"
CLI_OUT=$($MOAT exec -- /bin/sh -c 'cd /work && node src/cli.js "Hello   World, Crème Brûlée!"' 2>&1 | tail -2)
printf '%s\n' "$CLI_OUT" | tee -a "$LOG"

# The real assertion: the project's own suite, run by moat in a fresh boot of the
# same rootfs, passes AND reports no failures. Read the counts, not moat's prose.
FRESH_FAIL=$(printf '%s\n' "$FRESH_TESTS" | grep -oE '^ℹ fail [0-9]+' | awk '{print $3}')
FRESH_PASS=$(printf '%s\n' "$FRESH_TESTS" | grep -oE '^ℹ pass [0-9]+' | awk '{print $3}')
if [ "${FRESH_FAIL:-}" = "0" ] && [ "${FRESH_PASS:-0}" -ge 6 ] 2>/dev/null; then
  pass "the agent's fix passes the suite" "a fresh run in the box reports $FRESH_PASS passed, 0 failed"
else
  fail "the agent's fix passes the suite" \
    "a fresh run in the box reported pass=${FRESH_PASS:-none} fail=${FRESH_FAIL:-none}; full output above"
fi
if printf '%s' "$CLI_OUT" | grep -q "hello-world-creme-brulee"; then
  pass "the CLI works end to end" "the box ran node src/cli.js and it slugified the input"
else
  fail "the CLI works end to end" "the CLI did not print the slugified title (output above)"
fi

# ---------------------------------------------------------------------------
say ""
say "== 5. the network policy this session actually ran under"
# ---------------------------------------------------------------------------
say "the environment was booted with no --egress flag, so it took the default."
say "Measured in the same box that just did the work, not reported by moat: the"
say "allowlisted provider must answer and an address outside the list must not."
say ""
say "--- the allowlisted provider (401 is the answer without a key) ---"
PROVIDER_CODE=$($MOAT exec -- /bin/sh -c 'curl -sS -o /dev/null -w "%{http_code}" --max-time 25 https://api.deepseek.com/models' 2>&1 | tail -1)
say "provider answered: http $PROVIDER_CODE"
say ""
say "--- an address outside the allowlist ---"
OUTSIDE=$($MOAT exec -- /bin/sh -c 'curl -sS --max-time 6 -o /dev/null -w "code %{http_code}\n" https://1.1.1.1/ ; echo "curl-exit=$?"' 2>&1)
printf '%s\n' "$OUTSIDE" | tee -a "$LOG"

# Both halves, because either one alone is passable by the wrong box: a box with
# no network at all fails the first, and a box with the host's network passes the
# second. Only a filtered box answers the provider and drops 1.1.1.1.
if printf '%s' "$PROVIDER_CODE" | grep -qE "^(200|401)$"; then
  pass "the allowlisted provider is reachable" "the box got http $PROVIDER_CODE from api.deepseek.com"
else
  fail "the allowlisted provider is reachable" "the box got '${PROVIDER_CODE:-nothing}' from api.deepseek.com"
fi
if printf '%s' "$OUTSIDE" | grep -q "curl-exit=[1-9]"; then
  pass "an address outside the allowlist is not" "curl to 1.1.1.1 failed inside the box, as the policy requires"
else
  fail "an address outside the allowlist is not" "1.1.1.1 answered from inside the box: $OUTSIDE"
fi

# ---------------------------------------------------------------------------
say ""
say "== 6. copy the work back, without touching the working tree"
# ---------------------------------------------------------------------------
BEFORE_HEAD=$(git rev-parse HEAD)
BEFORE_STATUS=$(git status --porcelain)
run $MOAT fetch
AFTER_HEAD=$(git rev-parse HEAD)
AFTER_STATUS=$(git status --porcelain)
say "host HEAD before: $BEFORE_HEAD"
say "host HEAD after : $AFTER_HEAD"
if [ "$BEFORE_HEAD" = "$AFTER_HEAD" ]; then
  pass "fetch does not move host HEAD" "HEAD is $BEFORE_HEAD before and after"
else
  fail "fetch does not move host HEAD" "HEAD moved from $BEFORE_HEAD to $AFTER_HEAD"
fi
if [ "$BEFORE_STATUS" = "$AFTER_STATUS" ]; then
  pass "fetch does not touch the working tree" "git status --porcelain is byte-identical"
else
  fail "fetch does not touch the working tree" \
    "status changed: before='$BEFORE_STATUS' after='$AFTER_STATUS'"
fi
say ""
say "--- what the agent produced, as the host now sees it ---"
FETCHED_REF=$(git for-each-ref --format='%(refname:short)' refs/moat | head -1)
git log --oneline --decorate -3 "$FETCHED_REF" 2>/dev/null | tee -a "$LOG"
git diff --stat "$BEFORE_HEAD" "$(git for-each-ref --format='%(objectname)' 'refs/moat/*' | head -1)" 2>/dev/null | tee -a "$LOG"
# The work has to be reachable from the host, or the fetch reported success and
# brought nothing: one ref, and at least one commit the host did not have.
if [ -n "$FETCHED_REF" ] && [ "$(git rev-list --count "$BEFORE_HEAD".."$FETCHED_REF" 2>/dev/null)" != "0" ]; then
  pass "the work is reachable on the host" "$FETCHED_REF carries $(git rev-list --count "$BEFORE_HEAD".."$FETCHED_REF") commit(s) the host did not have"
else
  fail "the work is reachable on the host" "refs/moat holds nothing beyond $BEFORE_HEAD (ref='${FETCHED_REF:-none}')"
fi

# ---------------------------------------------------------------------------
say ""
say "== 7. a second turn in the same environment, without booting it again"
# ---------------------------------------------------------------------------
say "one runtime, so this is the same box and the same /work: a second task must not"
say "need another boot, and the file it writes must be there to read afterwards."
say ""
run timeout "$TIMEOUT" $MOAT run "Create a file named CODEX-LIVE.txt in the working tree whose contents are exactly: codex live. Do not modify any other file. Then finish."
say ""
say "--- the file, read by moat, and what the work tree looks like now ---"
SECOND_TURN=$($MOAT exec -- /bin/sh -c 'cat /work/CODEX-LIVE.txt; echo; git -C /work status --short | head -4' 2>&1)
printf '%s\n' "$SECOND_TURN" | tee -a "$LOG"
if printf '%s' "$SECOND_TURN" | grep -qx "codex live"; then
  pass "a second turn works in the same box" "CODEX-LIVE.txt reads 'codex live' in the box that ran the first turn"
else
  fail "a second turn works in the same box" "CODEX-LIVE.txt was not there or not the right contents: $SECOND_TURN"
fi

# ---------------------------------------------------------------------------
say ""
say "== 8. teardown"
# ---------------------------------------------------------------------------
run $MOAT down
say ""
say "evidence: $LOG"
say "REMINDER: revoke the $KEYVAR you used for this run."
# The verdict decides the exit status. Without it this suite was a recorder: every
# line informational, exit 0 whatever the live model had done.
verdict
exit $?
