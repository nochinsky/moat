#!/usr/bin/env bash
#
# The CI entrypoint's own logic, with a fake `moat` standing in for the CLI.
#
# This is the half of `scripts/ci/run-task.sh` that can be tested anywhere: which branch is taken,
# what is printed, which exit code comes back, and — the one that matters — that a host which
# cannot sandbox is refused *before* anything runs. It needs no user namespaces, so unlike the
# sandbox suites it can run on a hosted CI runner, and `ci.yml` runs it for exactly that reason.
#
# The other half — a real task in a real box — is `test/e2e-extras.sh` §AN, which needs the feature
# this one is checking *for*.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$REPO/scripts/ci/run-task.sh"
FAILED=0
PASSED=0

pass() { PASSED=$((PASSED + 1)); printf '  pass  %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n' "$1"
  FAILED=$((FAILED + 1))
}

# A `moat` that answers `doctor --json` from the environment and the other two subcommands with
# whatever exit code the case wants.
fake_moat() {
  local dir="$1"
  cat > "$dir/moat" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  doctor)
    if [ "${FAKE_USERNS:-yes}" = "yes" ]; then
      printf '{"host":{"userns":true,"problems":[]}}\n'
    else
      printf '{"host":{"userns":false,"problems":["unprivileged user namespaces are unavailable: `unshare --user --map-root-user` could not mount a tmpfs. moat has no host fallback, so it cannot run here."]}}\n'
    fi
    exit 0
    ;;
  run)  echo "fake run $*" ; exit "${FAKE_RUN_CODE:-0}" ;;
  take) echo "fake take $*"; exit "${FAKE_TAKE_CODE:-0}" ;;
  *)    echo "fake moat: unexpected $*" >&2; exit 9 ;;
esac
SH
  chmod +x "$dir/moat"
}

work="$(mktemp -d "${TMPDIR:-/tmp}/moat-ci-test-XXXXXX")"
trap 'rm -rf "$work"' EXIT
fake_moat "$work"

run_entry() { # run_entry <case-dir> <env...>
  local out="$1"; shift
  mkdir -p "$out"
  ( cd "$out" && env MOAT="$work/moat" OUTPUT_DIR="$out/moat-ci" "$@" bash "$ENTRY" ) > "$out/entry.log" 2>&1
  echo $?
}

printf 'the CI entrypoint, both branches\n'

# 1. A host that cannot sandbox: refused, with the doctor's own reason, and NOTHING run.
d="$work/case1"
code=$(run_entry "$d" FAKE_USERNS=no TASK="fix the tests")
if [ "$code" = "2" ] && grep -q 'cannot run the sandbox' "$d/entry.log" && grep -q 'unprivileged user namespaces are unavailable' "$d/entry.log"; then
  pass "a host without user namespaces is refused, with the reason"
else
  fail "expected exit 2 and the doctor's reason (got $code)"
fi
if [ ! -f "$d/moat-ci/task.log" ]; then
  pass "nothing was run before the refusal"
else
  fail "the task ran on a host that cannot sandbox"
fi

# 2. The happy path: task and review both succeed.
d="$work/case2"
code=$(run_entry "$d" FAKE_USERNS=yes TASK="fix the tests")
if [ "$code" = "0" ] && [ -s "$d/moat-ci/task.log" ] && [ -s "$d/moat-ci/review.txt" ]; then
  pass "a task ran and the review was written"
else
  fail "expected exit 0 and both artefacts (got $code)"
fi
if grep -q 'the host tree was not written' "$d/entry.log"; then
  pass "the summary says the tree was not written (apply is a separate step)"
else
  fail "the summary does not say the host tree was left alone"
fi

# 3. The task fails: the entrypoint must not report success.
d="$work/case3"
code=$(run_entry "$d" FAKE_USERNS=yes TASK="fix the tests" FAKE_RUN_CODE=7)
if [ "$code" = "1" ] && grep -q 'the task failed (exit 7)' "$d/entry.log"; then
  pass "a failed task fails the run, and names the code"
else
  fail "expected exit 1 and the task's code (got $code)"
fi

# 4. The review fails after a good task: also not a success.
d="$work/case4"
code=$(run_entry "$d" FAKE_USERNS=yes TASK="fix the tests" FAKE_TAKE_CODE=3)
if [ "$code" = "1" ] && grep -q 'the review failed (exit 3)' "$d/entry.log"; then
  pass "a failed review fails the run"
else
  fail "expected exit 1 and the take code (got $code)"
fi

# 5. No task named.
d="$work/case5"
code=$(run_entry "$d" FAKE_USERNS=yes)
if [ "$code" = "2" ] && grep -q 'TASK is empty' "$d/entry.log"; then
  pass "an empty task is refused"
else
  fail "expected exit 2 for an empty task (got $code)"
fi

printf '\n'
if [ "$FAILED" = "0" ]; then
  echo "ci entrypoint: $PASSED checks, 0 failed"
  exit 0
fi
echo "ci entrypoint: $FAILED failed"
exit 1
