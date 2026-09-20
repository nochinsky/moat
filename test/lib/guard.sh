#!/usr/bin/env bash
#
# The failure accumulator the bash suites share.
#
# `test/e2e-extras.sh` printed the word FAILED in 46 places and accumulated none
# of them, and its last statement was `scrub_evidence`, so its exit status was
# whatever that `sed` loop returned, which is 0. The suite could report a broken
# sandbox in its own evidence file and still exit 0. `test/e2e-live.sh` was the
# same shape with no assertions at all. A check that cannot fail is not a check
# (docs/PROGRAM.md §3), and a suite nobody can gate on is worse than no suite.
#
# Sourced, not executed. It defines four functions and one counter:
#
#   check_count                 reset the counter (call once, at the top)
#   pass "<what held>"          record that a check held and passed
#   fail "<check>" "<reason>"   record that a check failed
#   verdict                     print the summary, return the exit status
#
# Exit status: 0 when every check passed, 1 when any failed, 2 when no check ran
# at all. That third case is deliberate: a suite that asserts nothing must not
# report success, because "nothing failed" and "nothing was checked" are only the
# same thing to a broken suite.
#
# `tee` keeps the line on stdout as well as in the evidence file, so a failure is
# visible in a terminal that is not tailing the log.
#
# The guard has its own proof, with a positive and a negative control:
# `bash test/fail-guard.sh`. Its negative control asserts nothing and must exit 2.
#
# Requires one variable, set by the sourcing script before `.`:
#   CHECKS_LOG   the evidence file these lines are appended to (absolute path)
#
# It is a parameter rather than a constant because the two suites keep different
# evidence files (extras.txt, live-session.txt) and one of them having its verdict
# land in the other's log would read as a second, contradictory summary.

CHECKS_PASSED=0
CHECKS_FAILED=0

check_count() {
  CHECKS_PASSED=0
  CHECKS_FAILED=0
}

# Record a line in the evidence file and on the terminal.
#
# Written as a redirect and a `tee`, never as a pipeline at the call site. This is
# the trap the first version of this guard fell into: `fail "x" "y" | tee -a log`
# runs `fail` in a *subshell*, so `CHECKS_FAILED=$((CHECKS_FAILED + 1))` happened
# inside a process that then exited, and the parent's counter stayed at zero. Forty
# FAILED lines, an exit status of 2 ("no checks ran"), and a gate to gate on. The
# function does its own logging so the call site cannot reintroduce that.
record() {
  echo "$1" | tee -a "$CHECKS_LOG"
}

# One check that held. Reporting these is not decoration: a suite that counts only
# failures cannot tell "everything ran" from "everything was skipped".
pass() {
  CHECKS_PASSED=$((CHECKS_PASSED + 1))
  record "  pass  $1"
}

# One check that failed: its name, and what was expected instead.
fail() {
  CHECKS_FAILED=$((CHECKS_FAILED + 1))
  record "$1: FAILED — $2"
}

# The last word. Has to be called *after* scrub_evidence: the evidence is exactly
# what someone reads to find out what broke, so it must still be written on a
# failed run.
verdict() {
  record ""
  local total=$((CHECKS_PASSED + CHECKS_FAILED))
  if [ "$total" = "0" ]; then
    record "NO CHECKS RAN: this suite asserted nothing, so it cannot report success"
    return 2
  fi
  if [ "$CHECKS_FAILED" = "0" ]; then
    record "checks passed: $CHECKS_PASSED, failed: 0"
    return 0
  fi
  record "checks passed: $CHECKS_PASSED, FAILED: $CHECKS_FAILED"
  record "read the \"FAILED\" lines above, and $CHECKS_LOG"
  return 1
}
