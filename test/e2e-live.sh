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
MODEL="${1:-deepseek-v4-pro}"
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
say "note: no output appears until the turn completes; watch the sandbox log for progress"
run timeout "$TIMEOUT" $MOAT attach --show-output --prompt \
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
$MOAT exec -- /bin/sh -c 'cd /work && npm test 2>&1 | grep -E "^# (tests|pass|fail)"' 2>&1 | tee -a "$LOG"
say ""
say "--- the CLI, end to end ---"
$MOAT exec -- /bin/sh -c 'cd /work && node src/cli.js "Hello   World, Crème Brûlée!"' 2>&1 | tail -2 | tee -a "$LOG"

# ---------------------------------------------------------------------------
say ""
say "== 5. copy the work back, without touching the working tree"
# ---------------------------------------------------------------------------
BEFORE_HEAD=$(git rev-parse HEAD)
BEFORE_STATUS=$(git status --porcelain)
run $MOAT fetch
say "host HEAD before: $BEFORE_HEAD"
say "host HEAD after : $(git rev-parse HEAD)"
[ "$BEFORE_HEAD" = "$(git rev-parse HEAD)" ] && say "HEAD unchanged: yes" || say "HEAD unchanged: NO"
[ "$BEFORE_STATUS" = "$(git status --porcelain)" ] && say "working tree unchanged: yes" || say "working tree unchanged: NO"
say ""
say "--- what the agent produced, as the host now sees it ---"
git log --oneline --decorate -3 "refs/moat/$(git for-each-ref --format='%(refname:short)' refs/moat | head -1 | sed 's|^moat/||')" 2>/dev/null | tee -a "$LOG"
git diff --stat "$BEFORE_HEAD" "$(git for-each-ref --format='%(objectname)' 'refs/moat/*' | head -1)" 2>/dev/null | tee -a "$LOG"

# ---------------------------------------------------------------------------
say ""
say "== 6. teardown"
# ---------------------------------------------------------------------------
run $MOAT down
say ""
say "evidence: $LOG"
say "REMINDER: revoke the $KEYVAR you used for this run."
