#!/usr/bin/env bash
#
# moat verification, part 2: claims that are not in the main acceptance list
# but are made in docs/SPEC.md and the README, so they get the same
# treatment, a command, its real output, and no adjectives.
#
# Covers: rootfs snapshots and restore, `moat apply` (the explicit second step of
# copy-out), `moat env`, and credential expiry enforcement.
#
# Usage: bash test/e2e-extras.sh   (run after test/e2e.sh, in the same fixture)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOAT="node $REPO/cmd/main.ts"
WORK="${MOAT_E2E_DIR:-$HOME/moat-demo}"
PROJECT="$WORK/project"
EVIDENCE="$REPO/test/evidence"
MOCK_PORT="${MOCK_PORT:-5599}"
MOCK_PIDFILE="$WORK/mock.pid"
CREDENTIAL="moat-e2e-scoped-credential-8c1d4e"

mkdir -p "$EVIDENCE"

section() {
  {
    echo ""
    echo "=============================================================="
    echo "== $1"
    echo "=============================================================="
  } | tee -a "$EVIDENCE/extras.txt"
}

capture() {
  local name="$1"; shift
  {
    echo "--- \$ $*"
    "$@" > "$EVIDENCE/$name.out" 2> "$EVIDENCE/$name.err"
    echo "--- exit $?"
    echo "--- stdout ---"
    cat "$EVIDENCE/$name.out"
    echo "--- stderr ---"
    cat "$EVIDENCE/$name.err"
  } > "$EVIDENCE/$name.txt"
  cat "$EVIDENCE/$name.txt" | tee -a "$EVIDENCE/extras.txt"
}

: > "$EVIDENCE/extras.txt"
cd "$PROJECT"
export MOAT_MOCK_CREDENTIAL="$CREDENTIAL"

section "boot the fixture environment"
capture extras-up $MOAT up --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL

section "A. snapshots capture the rootfs and never the project"
capture snapshot-take $MOAT snapshot before-extras
capture exec-mark $MOAT exec -- /bin/sh -c "echo MARKER-ADDED-AFTER-SNAPSHOT > /opt/moat-extra; echo 'in-sandbox /opt now contains:'; ls /opt"
echo "" | tee -a "$EVIDENCE/extras.txt"
echo "host-side proof that /work is excluded from snapshots:" | tee -a "$EVIDENCE/extras.txt"
{
  echo "\$ tar tzf <snapshot> | grep -c '^\\./work'   # expect 0"
  SNAP=$(ls "$HOME"/.moat/envs/*/snapshots/before-extras.tar.gz | head -1)
  echo "snapshot: $SNAP"
  echo "entries under ./work : $(tar tzf "$SNAP" | grep -c '^\./work' || true)"
  echo "entries under ./root  : $(tar tzf "$SNAP" | grep -c '^\./root' || true)"
  echo "total entries         : $(tar tzf "$SNAP" | wc -l)"
} | tee -a "$EVIDENCE/extras.txt"

section "B. moat restore rolls the rootfs back and preserves /work"
capture snapshot-restore $MOAT restore before-extras --yes
capture exec-after-restore $MOAT exec -- /bin/sh -c "echo 'in-sandbox /opt after restore:'; ls /opt; echo '--- /work preserved? ---'; ls /work; echo '--- agent commit still present? ---'; git -C /work log --oneline -1"

section "C. moat apply is a separate, explicit step from moat fetch"
capture extras-up-again $MOAT up --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL
capture extras-fetch $MOAT fetch
capture apply-branch $MOAT apply main --name e2e-checkout
{
  echo "\$ git -C $PROJECT branch --list 'e2e-checkout'"
  git -C "$PROJECT" branch --list 'e2e-checkout'
  echo "\$ git -C $PROJECT rev-parse HEAD   # unchanged: apply did not check anything out"
  git -C "$PROJECT" rev-parse HEAD
  echo "\$ git -C $PROJECT status --porcelain   # only the user's own pre-existing dirt"
  git -C "$PROJECT" status --porcelain
} | tee -a "$EVIDENCE/extras.txt"

section "D. moat env reports the connection details"
capture env-details $MOAT env

section "E. the injected credential is short-lived, and expiry is enforced"
echo "booting with --credential-ttl 6s and watching the sandbox stop on its own..." | tee -a "$EVIDENCE/extras.txt"
capture down-for-ttl $MOAT down
capture up-short-ttl $MOAT up --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL --credential-ttl 6s
echo "waiting 12s for the TTL watchdog to fire..." | tee -a "$EVIDENCE/extras.txt"
sleep 12
capture status-after-ttl $MOAT status
echo "" | tee -a "$EVIDENCE/extras.txt"
echo "--- sandbox log: the expiry notice ---" | tee -a "$EVIDENCE/extras.txt"
{
  echo "\$ grep -iE 'expired|stopping agent' \$HOME/.moat/envs/*/logs/sandbox.log"
  grep -iE "expired|stopping agent|agent exited" "$HOME"/.moat/envs/*/logs/sandbox.log | tail -4
  echo ""
  echo "\$ moat status  -> status line above shows the box is stopped, which it did to itself"
} | tee -a "$EVIDENCE/extras.txt"

section "F. the interactive CLI, driven through a real pty"
echo "an interactive session cannot be checked by piping stdin, so this allocates a pty," | tee -a "$EVIDENCE/extras.txt"
echo "types at it, and reads what comes back. It starts its own stub and its own sandbox." | tee -a "$EVIDENCE/extras.txt"
python3 "$REPO/test/repl-smoke.py" > "$EVIDENCE/repl-smoke.txt" 2>&1
REPL_RC=$?
tail -12 "$EVIDENCE/repl-smoke.txt" | tee -a "$EVIDENCE/extras.txt"
echo "repl smoke exit: $REPL_RC" | tee -a "$EVIDENCE/extras.txt"

section "G. the agent can ask a question when someone is there to answer"
echo "only in interactive mode: an unattended question has no answer, so batch runs end the" | tee -a "$EVIDENCE/extras.txt"
echo "turn and say so rather than stalling until the timeout." | tee -a "$EVIDENCE/extras.txt"
python3 "$REPO/test/repl-questions.py" > "$EVIDENCE/repl-questions.txt" 2>&1
QUESTION_RC=$?
tail -8 "$EVIDENCE/repl-questions.txt" | tee -a "$EVIDENCE/extras.txt"
echo "question flow exit: $QUESTION_RC" | tee -a "$EVIDENCE/extras.txt"

section "H. the project's own checks, run by moat against the agent's work"
capture verify $MOAT verify
echo "the exit code above is the project's own verdict on whatever is in the sandbox." | tee -a "$EVIDENCE/extras.txt"

section "I. bare moat in an empty, non-git directory: work, then apply, without leaving"
echo "the flow the tool exists for. A plain directory with nothing in it had no copy-out" | tee -a "$EVIDENCE/extras.txt"
echo "path at all before this: there is no host repository for git fetch to write into." | tee -a "$EVIDENCE/extras.txt"
python3 "$REPO/test/repl-apply.py" > "$EVIDENCE/repl-apply.txt" 2>&1
APPLY_RC=$?
tail -10 "$EVIDENCE/repl-apply.txt" | tee -a "$EVIDENCE/extras.txt"
echo "apply flow exit: $APPLY_RC" | tee -a "$EVIDENCE/extras.txt"

section "J. first run with no key: it asks, checks, and saves"
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  python3 "$REPO/test/onboard-smoke.py" > "$EVIDENCE/onboard.txt" 2>&1
  ONBOARD_RC=$?
  tail -10 "$EVIDENCE/onboard.txt" | tee -a "$EVIDENCE/extras.txt"
  echo "onboarding exit: $ONBOARD_RC" | tee -a "$EVIDENCE/extras.txt"
else
  echo "skipped: needs DEEPSEEK_API_KEY to prove the accepted path (it refuses a fake key first)" | tee -a "$EVIDENCE/extras.txt"
fi

section "K. every claim about process state is reconciled against the live process table"
capture status-final $MOAT status
capture down-final $MOAT down
if [ -f "$MOCK_PIDFILE" ]; then kill "$(cat "$MOCK_PIDFILE")" 2>/dev/null; fi
echo "" | tee -a "$EVIDENCE/extras.txt"
echo "extras evidence written to $EVIDENCE/extras.txt" | tee -a "$EVIDENCE/extras.txt"
