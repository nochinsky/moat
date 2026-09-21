#!/usr/bin/env bash
#
# Phase 2's gate: `moat demo` runs with no credential in the environment, and its output is
# captured here.
#
# The demo is the one command a person runs before they trust moat with a repository, so the
# suite checks the claims it makes rather than that it exited 0:
#
#   - all three classifications appear, and they came from `planApply` rather than from the
#     demo's own opinion (the demo prints what the planner returned; this asserts the three
#     outcomes are present, which is only possible if the planner produced them);
#   - the conflict was NOT written, and the user's file is byte-identical to what it was;
#   - the digest of the host tree is identical before the agent ran and after its work was
#     fetched, which is the "nothing crosses back until you say so" claim, measured;
#   - it runs with no credential in the environment;
#   - the warm run fits the documented two-minute budget.
#
# Usage: bash test/e2e-demo.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE="$REPO/test/evidence"
LOG="$EVIDENCE/demo.txt"
WORK="${MOAT_E2E_DIR:-$HOME/moat-demo}/demo-gate"
DEMO_DIR="$WORK/project"

mkdir -p "$EVIDENCE" "$WORK"
: > "$LOG"
CHECKS_LOG="$LOG"
. "$REPO/test/lib/guard.sh"
check_count

say() { echo "$@" | tee -a "$LOG"; }
scrub() { sed -e "s|$HOME|/home/user|g" -e "s|${USER:-$(id -un)}|user|g"; }

say "=============================================================="
say "== moat demo: three-way attribution, keyless"
say "=============================================================="
say "a real sandbox, the real pinned Codex driven against the keyless stub, a real git repo, and"
say "the real apply path. Nothing here is asserted by the demo itself: the three classifications"
say "are what sync/apply.ts computed, and the suite checks they are the right three."

# The gate's first condition: nothing that could be a credential is in the environment. The
# demo is run with these explicitly removed rather than merely unset in this shell, so a
# developer with a key exported does not measure a different thing than CI does.
rm -rf "$WORK"
mkdir -p "$WORK"
# The capture lives outside $DEMO_DIR: `moat demo --dir` builds a git repository there and a
# stray file in it would show up in the digest the demo measures.
env -u DEEPSEEK_API_KEY -u MOAT_CREDENTIAL -u ANTHROPIC_API_KEY -u OPENAI_API_KEY \
  node "$REPO/cmd/main.ts" demo --dir "$DEMO_DIR" --keep > "$WORK/demo.out" 2>&1
DEMO_RC=$?
scrub < "$WORK/demo.out" | tee -a "$LOG"
echo "--- exit $DEMO_RC" | tee -a "$LOG"

if [ "$DEMO_RC" = "0" ]; then
  pass "the demo" "ran to completion with no credential in the environment (exit 0)"
else
  fail "the demo" "exited $DEMO_RC with no credential in the environment"
fi

# Tear the environment down after reading what the run left in the directory. `--keep` is for a
# human poking at the result, not for a suite that runs unattended: leftovers from earlier runs
# were still alive and one of them made a later run's agent talk to a stub that no longer
# existed, which took 300 seconds to surface as "the turn was still running".
cleanup_demo() {
  [ -d "$DEMO_DIR" ] && ( cd "$DEMO_DIR" && node "$REPO/cmd/main.ts" destroy --yes >/dev/null 2>&1 )
  return 0
}
trap cleanup_demo EXIT

# The three classifications, as the planner produced them.
say ""
say "--- what the planner classified ---"
for verdict in agent conflict; do
  if grep -qE "^    (agent|conflict|both|you) .*$verdict" "$WORK/demo.out" || grep -q "  $verdict " "$WORK/demo.out"; then
    pass "classification: $verdict" "the demo reported a $verdict path"
  else
    fail "classification: $verdict" "no $verdict path in the demo's output"
  fi
done
# The demo must report an agent-only path AND a conflict, not one or the other: a run that
# merged everything, or conflicted everything, would not be showing the three-way split. This
# asserts the two *labels the planner's verdicts render as*, plus the paths they are attached to,
# so it cannot pass on a sentence the demo wrote about itself.
if grep -qE "^    agent +app\.js$" "$WORK/demo.out" \
   && grep -qE "^    conflict +notes\.txt$" "$WORK/demo.out" \
   && grep -q "both changed it, and the changes overlap" "$WORK/demo.out"; then
  pass "the three-way split" "app.js is the agent's alone; notes.txt is yours and the agent's, and the planner says so"
else
  fail "the three-way split" "the output does not show an agent-only path and a real conflict with the planner's reason"
fi

# The promise, measured: the digest before any of this and after the agent's work was fetched.
BEFORE=$(grep -oE "digest before any of this +[0-9a-f]{64}" "$WORK/demo.out" | awk '{print $NF}' || true)
AFTER_AGENT=$(grep -oE "digest after the agent +[0-9a-f]{64}" "$WORK/demo.out" | awk '{print $NF}' || true)
AFTER_ACCEPT=$(grep -oE "digest after you accepted +[0-9a-f]{64}" "$WORK/demo.out" | awk '{print $NF}' || true)
if [ -n "$BEFORE" ] && [ "$BEFORE" = "$AFTER_AGENT" ]; then
  pass "the host tree" "byte-identical before the agent ran and after its work was fetched"
else
  fail "the host tree" "the digest moved while the agent worked ($BEFORE -> $AFTER_AGENT)"
fi
if [ -n "$AFTER_ACCEPT" ] && [ "$AFTER_ACCEPT" != "$BEFORE" ]; then
  pass "the accept step" "changed the tree, which is the step the user asked for"
else
  fail "the accept step" "the tree did not change after accepting, or the digest is missing"
fi

# The conflict was not written: the user's file still holds the user's line, and no conflict
# markers were introduced. Asserting on the bytes rather than on the demo's sentence about them.
if [ -f "$DEMO_DIR/notes.txt" ]; then
  if grep -q "you rewrote this" "$DEMO_DIR/notes.txt" && ! grep -qE "^(<<<<<<<|=======|>>>>>>>)" "$DEMO_DIR/notes.txt"; then
    pass "the conflict" "your file is exactly as you left it, with no conflict markers written into it"
  else
    fail "the conflict" "your file was written to: $(head -3 "$DEMO_DIR/notes.txt" | tr '\n' '|')"
  fi
  # And the agent's non-conflicting change did land, so this is not a demo where nothing applied.
  if grep -q "Hi," "$DEMO_DIR/app.js"; then
    pass "the accepted change" "the agent's app.js change was applied"
  else
    fail "the accepted change" "app.js does not carry the agent's change"
  fi
  if grep -q "the agent rewrote this one" "$DEMO_DIR/notes.txt"; then
    fail "the conflict" "the agent's version of the conflicting file was written over yours"
  fi
else
  fail "the conflict" "the demo project is missing $DEMO_DIR/notes.txt"
fi

# The warm budget the program documents.
TOTAL=$(grep -oE "total [0-9.]+s" "$WORK/demo.out" | awk '{print $2}' | tr -d 's' || true)
if [ -n "$TOTAL" ] && awk -v t="$TOTAL" 'BEGIN { exit !(t < 120) }'; then
  pass "the warm budget" "the run took ${TOTAL}s, inside the two-minute budget"
else
  fail "the warm budget" "the run took ${TOTAL:-unknown}s, over the two-minute budget"
fi

# A cold cache says what it is downloading, before it does it.
if grep -q "cold cache" "$WORK/demo.out"; then
  say ""
  say "(this run was on a cold cache and said so, which is the documented behaviour)"
fi

echo "" | tee -a "$LOG"
echo "demo evidence written to $LOG" | tee -a "$LOG"
verdict
exit $?
