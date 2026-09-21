#!/usr/bin/env bash
#
# The proof that the failure accumulator works, and can be made to fail.
#
# `test/lib/guard.sh` is what decides whether e2e-extras.sh and e2e-live.sh exit
# zero, so it is the one piece of test machinery that must not be trusted on
# inspection. This runs it three times:
#
#   1. positive control: three checks pass, exit must be 0
#   2. negative control: one check fails among passes, exit must be 1
#   3. empty control:    no checks run at all, exit must be 2
#
# and then proves the wiring end to end: an actual `test/e2e-extras.sh` run with
# one check deliberately broken must exit non-zero. That last part is what the
# Phase 0 gate asks for, and it is opt-in because it boots a real sandbox
# (`MOAT_FAIL_GUARD_E2E=1 bash test/fail-guard.sh`).
#
# Usage: bash test/fail-guard.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
if [ "${MOAT_FAIL_GUARD_KEEP:-}" = "1" ]; then trap 'echo "kept: $TMP"' EXIT; else trap 'rm -rf "$TMP"' EXIT; fi
FAIL=0

note() { echo "$@" ; }
ok() { echo "  pass  $1"; }
bad() { echo "  FAIL  $1"; FAIL=1; }

# ---------------------------------------------------------------------------
note "== 1. the control: a suite that passes must exit 0"
# ---------------------------------------------------------------------------
EVIDENCE="$TMP/positive"
mkdir -p "$EVIDENCE"
(
  set -uo pipefail
  EVIDENCE="$TMP/positive"
  CHECKS_LOG="$EVIDENCE/extras.txt"
  . "$REPO/test/lib/guard.sh"
  check_count
  pass "the first thing held"
  pass "the second thing held"
  pass "the third thing held"
  verdict
) > "$TMP/positive.out" 2>&1
POS=$?
[ "$POS" = "0" ] && ok "three passing checks exit 0" || bad "three passing checks exited $POS, wanted 0"
grep -q "checks passed: 3, failed: 0" "$TMP/positive.out" \
  && ok "the summary names the pass count" || bad "the summary did not name the pass count"

# ---------------------------------------------------------------------------
note ""
note "== 2. the negative control: one broken check must exit non-zero"
# ---------------------------------------------------------------------------
# This is the whole point. Reintroducing the original bug (a FAILED line that
# does not reach the exit status) makes this case exit 0 and the harness fail.
EVIDENCE="$TMP/negative"
mkdir -p "$EVIDENCE"
(
  set -uo pipefail
  EVIDENCE="$TMP/negative"
  CHECKS_LOG="$EVIDENCE/extras.txt"
  . "$REPO/test/lib/guard.sh"
  check_count
  pass "the first thing held"
  fail "the thing that broke" "it was expected to hold and did not"
  pass "the third thing held"
  verdict
) > "$TMP/negative.out" 2>&1
NEG=$?
[ "$NEG" = "1" ] && ok "one failing check exits 1" || bad "one failing check exited $NEG, wanted 1"
grep -q 'the thing that broke: FAILED — it was expected to hold and did not' "$TMP/negative.out" \
  && ok "the failing check is named, with its reason" || bad "the failing check was not named"
grep -q "checks passed: 2, FAILED: 1" "$TMP/negative.out" \
  && ok "the summary counts both sides" || bad "the summary did not count both sides"

# The old shape, for comparison: a bare FAILED echo with no accumulator. This is
# what the suite used to be, and it exits 0, which is why the suite could not be
# gated on.
(
  set -uo pipefail
  echo "something: FAILED — this is the old shape"
  exit 0
) > /dev/null 2>&1
OLD=$?
[ "$OLD" = "0" ] && ok "control: a bare FAILED line still exits 0 (the bug being fixed)" \
  || bad "the old-shape control exited $OLD, so this harness is not measuring what it claims"

# ---------------------------------------------------------------------------
note ""
note "== 3. the pipeline control: a call in a subshell must not lose its count"
# ---------------------------------------------------------------------------
# This is the trap the first version of the guard fell into, and the cheap half of
# this harness did not catch it -- the end-to-end run did, with forty FAILED lines
# and an exit status of 2, which says "no checks ran". `fail "x" "y" | tee -a log`
# runs `fail` in a subshell: the increment happens in a process that then exits and
# the parent's counter is untouched. A call site must never reintroduce the pipe.
EVIDENCE="$TMP/subshell"
mkdir -p "$EVIDENCE"
(
  set -uo pipefail
  EVIDENCE="$TMP/subshell"
  CHECKS_LOG="$EVIDENCE/extras.txt"
  . "$REPO/test/lib/guard.sh"
  check_count
  pass "counted properly" > /dev/null
  fail "piped the wrong way" "the increment stayed in the subshell" | tee -a "$CHECKS_LOG" > /dev/null
  verdict
) > "$TMP/subshell.out" 2>&1
SUB=$?
grep -q "checks passed: 1, failed: 0" "$TMP/subshell.out" \
  && ok "control: a piped call loses its increment (the shape the suites must avoid)" \
  || bad "a piped call did not lose its increment, so this control no longer models the bug"
[ "$SUB" = "0" ] \
  && ok "control: and the verdict is wrong because of it, which is why the call sites are grepped" \
  || bad "the subshell control exited $SUB, which is not the shape being modelled"

# ---------------------------------------------------------------------------
note ""
note "== 4. the empty control: a suite that asserts nothing must not pass"
# ---------------------------------------------------------------------------
EVIDENCE="$TMP/empty"
mkdir -p "$EVIDENCE"
(
  set -uo pipefail
  EVIDENCE="$TMP/empty"
  CHECKS_LOG="$EVIDENCE/extras.txt"
  . "$REPO/test/lib/guard.sh"
  check_count
  verdict
) > "$TMP/empty.out" 2>&1
EMPTY=$?
[ "$EMPTY" = "2" ] && ok "no checks at all exits 2, not 0" || bad "an assertion-free suite exited $EMPTY, wanted 2"
grep -q "NO CHECKS RAN" "$TMP/empty.out" && ok "and it says so" || bad "it did not say that nothing ran"

# ---------------------------------------------------------------------------
note ""
note "== 5. the wiring: the real suite's exit status follows its checks"
# ---------------------------------------------------------------------------
# Grep-level first, so this part is cheap and always runs: the suite must call
# `verdict` after `scrub_evidence`, and must not have a bare `echo ... FAILED`
# left that nobody counts.
if grep -q "^scrub_evidence$" "$REPO/test/e2e-extras.sh" \
   && [ "$(grep -n '^scrub_evidence$' "$REPO/test/e2e-extras.sh" | cut -d: -f1)" -lt \
        "$(grep -n '^verdict$' "$REPO/test/e2e-extras.sh" | cut -d: -f1)" ]; then
  ok "e2e-extras.sh decides its exit status after scrubbing the evidence"
else
  bad "e2e-extras.sh does not call verdict after scrub_evidence"
fi
UNCOUNTED=$(grep -c 'echo "[^"]*FAILED' "$REPO/test/e2e-extras.sh" || true)
[ "$UNCOUNTED" = "0" ] && ok "no failure line bypasses the accumulator" \
  || bad "$UNCOUNTED failure line(s) still print FAILED without being counted"
PIPED=$(grep -cE '^[[:space:]]*(pass|fail) ".*" \| tee' "$REPO/test/e2e-extras.sh" "$REPO/test/e2e-live.sh" | awk -F: '{n += $2} END {print n + 0}')
[ "$PIPED" = "0" ] && ok "no check is recorded through a pipeline, where its count would be lost" \
  || bad "$PIPED check(s) record through a pipe, so their increments stay in a subshell"

if [ "${MOAT_FAIL_GUARD_E2E:-}" = "1" ]; then
  note ""
  note "the end-to-end half: a real suite run with one check deliberately broken"
  note "(boots real sandboxes and runs the whole suite, so about seven minutes;"
  note "MOAT_FAIL_GUARD_E2E=1 asked for it)"
  # The sabotage is applied to the real suite *in place*, with a restore in the
  # trap, and that is deliberate. The first version sabotaged a copy in a temp
  # directory and it proved nothing: the suite resolves its own repository root
  # from `${BASH_SOURCE[0]}`, so the copy could not find bundle/codex.ts or
  # test/codex-tui.py, every boot failed, and dozens of unrelated checks failed
  # with it. A harness that breaks the thing it measures measures itself.
  SUITE="$REPO/test/e2e-extras.sh"
  BACKUP="$TMP/e2e-extras.sh.orig"
  cp "$SUITE" "$BACKUP"
  restore_suite() {
    cp "$BACKUP" "$SUITE"
    echo "restored $SUITE"
  }
  # Restore on any exit, including a failure or a signal: the working tree must not
  # keep a sabotaged suite.
  trap 'restore_suite; if [ "${MOAT_FAIL_GUARD_KEEP:-}" = "1" ]; then echo "kept: $TMP"; else rm -rf "$TMP"; fi' EXIT INT TERM
  # Break a check that runs early and asserts on real output. Section C's
  # `moat apply --name` check reads a real `git branch --list` from the fixture
  # repository; demanding a branch name that cannot exist makes the check fail at
  # the point where the suite would otherwise have passed it. The break is inside
  # the suite's own assertion machinery, not a skipped section, because the
  # machinery is what is being tested: a check is only a check if it can fail.
  if python3 - "$SUITE" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()

needle = "if printf '%s' \"$APPLIED_BRANCH\" | grep -q 'e2e-checkout'; then"
if needle not in text:
    sys.exit("sabotage target not found: the apply --name check moved")
text = text.replace(needle, "if printf '%s' \"$APPLIED_BRANCH\" | grep -q 'THIS-CANNOT-MATCH'; then", 1)

# One patch only: the exit status must stay the suite's own. An earlier version also
# appended an end-of-run marker through an EXIT trap, which was harmless to $? but
# made the harness claim something it could not observe.
open(path, "w").write(text)
PY
  then
    note "running the sabotaged suite; it must exit non-zero..."
    bash "$SUITE" > "$TMP/sabotaged.log" 2>&1
    SAB=$?
    if [ "$SAB" != "0" ]; then
      ok "a sabotaged check made the suite exit $SAB"
    else
      bad "the sabotaged suite still exited 0: the gate does not hold"
    fi
    if grep -q "FAILED: 1" "$REPO/test/evidence/extras.txt"; then
      ok "and the evidence names exactly one broken check"
    elif grep -qE "FAILED: [0-9]+" "$REPO/test/evidence/extras.txt"; then
      bad "the sabotaged run recorded $(grep -oE 'FAILED: [0-9]+' "$REPO/test/evidence/extras.txt" | tail -1): the sabotage was not the only break"
    else
      bad "the sabotaged run recorded no failed check at all"
    fi
    # No end-of-run claim here. An earlier version checked that the sabotaged run had
    # NOT reached the end, which required an early stop; two attempts at one both put
    # the halt after the failure was counted, and `verdict` is the suite's last
    # statement, so neither could stop anything (see test/lib/guard.sh). The EXIT trap
    # that recorded the end also fired on every exit, so the check could not have
    # distinguished the two cases even if the halt had worked. What this half has to
    # show is the two claims above: a non-zero exit, and exactly one failed check.
  else
    bad "could not sabotage the copied suite"
  fi
else
  note ""
  note "skipping the end-to-end half (set MOAT_FAIL_GUARD_E2E=1 to run one full"
  note "e2e-extras.sh pass with a broken check; it boots a real sandbox)."
fi

note ""
if [ "$FAIL" = "0" ]; then
  echo "fail-guard: the accumulator passes, fails when it should, and refuses to pass empty"
else
  echo "fail-guard: FAILED"
fi
exit "$FAIL"
