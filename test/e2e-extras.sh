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
  } | scrub | tee -a "$EVIDENCE/extras.txt"
}

# Evidence is committed to a public repository, so the machine it was produced on
# is scrubbed out of it. What matters is the behaviour being shown, not whose
# home directory it ran in; without this the recorded proof publishes a username.
scrub() {
  sed -e "s|$HOME|/home/user|g" -e "s|${USER:-$(id -un)}|user|g"
}

# Last word. Inline scrubbing cannot cover output that arrives through a child
# process, a log file or a command substitution nobody thought about, and a
# single missed pipe publishes the machine's paths in a public repository. So
# every evidence file gets one final pass before the suite reports.
scrub_evidence() {
  local f
  for f in "$EVIDENCE"/*.txt; do
    [ -f "$f" ] || continue
    sed -i -e "s|$HOME|/home/user|g" -e "s|${USER:-$(id -un)}|user|g" "$f"
  done
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
  } | scrub > "$EVIDENCE/$name.txt"
  cat "$EVIDENCE/$name.txt" | tee -a "$EVIDENCE/extras.txt"
}

: > "$EVIDENCE/extras.txt"
cd "$PROJECT"
export MOAT_MOCK_CREDENTIAL="$CREDENTIAL"

section "boot the fixture environment"
capture extras-up $MOAT up --runtime opencode --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL

section "A. snapshots capture the rootfs and never the project"
# The box is running here; --yes acknowledges that a live rootfs can be torn.
capture snapshot-take $MOAT snapshot before-extras --yes
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
} | scrub | tee -a "$EVIDENCE/extras.txt"

section "B. moat restore rolls the rootfs back and preserves /work"
capture snapshot-restore $MOAT restore before-extras --yes
capture exec-after-restore $MOAT exec -- /bin/sh -c "echo 'in-sandbox /opt after restore:'; ls /opt; echo '--- /work preserved? ---'; ls /work; echo '--- agent commit still present? ---'; git -C /work log --oneline -1"

section "C. moat apply is a separate, explicit step from moat fetch"
capture extras-up-again $MOAT up --runtime opencode --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL
capture extras-fetch $MOAT fetch
capture apply-branch $MOAT apply main --name e2e-checkout
{
  echo "\$ git -C $PROJECT branch --list 'e2e-checkout'"
  git -C "$PROJECT" branch --list 'e2e-checkout'
  if git -C "$PROJECT" branch --list 'e2e-checkout' | grep -q 'e2e-checkout'; then
    echo "  pass  the local branch was created from the fetched ref"
  else
    echo "  FAIL  the local branch was not created"
  fi
  echo "\$ git -C $PROJECT rev-parse HEAD   # unchanged: apply did not check anything out"
  git -C "$PROJECT" rev-parse HEAD
  echo "\$ git -C $PROJECT status --porcelain   # only the user's own pre-existing dirt"
  git -C "$PROJECT" status --porcelain
} | scrub | tee -a "$EVIDENCE/extras.txt"

section "D. moat env reports the connection details"
capture env-details $MOAT env

section "E. the injected credential is short-lived, and expiry is enforced"
echo "booting with --credential-ttl 6s and watching the sandbox stop on its own..." | tee -a "$EVIDENCE/extras.txt"
capture down-for-ttl $MOAT down
capture up-short-ttl $MOAT up --runtime opencode --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL --credential-ttl 6s
echo "waiting 12s for the TTL watchdog to fire..." | tee -a "$EVIDENCE/extras.txt"
sleep 12
capture status-after-ttl $MOAT status
echo "" | tee -a "$EVIDENCE/extras.txt"
echo "--- sandbox log: the expiry notice ---" | tee -a "$EVIDENCE/extras.txt"
{
  echo "\$ grep -iE 'expired|stopping agent' \$HOME/.moat/envs/*/rootfs/var/log/moat/boot.log"
  grep -iE "expired|stopping agent|agent exited" "$HOME"/.moat/envs/*/rootfs/var/log/moat/boot.log | tail -4
  echo ""
  echo "\$ moat status  -> status line above shows the box is stopped, which it did to itself"
} | scrub | tee -a "$EVIDENCE/extras.txt"

section "F. the interactive CLI, driven through a real pty"
echo "an interactive session cannot be checked by piping stdin, so this allocates a pty," | tee -a "$EVIDENCE/extras.txt"
echo "types at it, and reads what comes back. It starts its own stub and its own sandbox." | tee -a "$EVIDENCE/extras.txt"
python3 "$REPO/test/repl-smoke.py" 2>&1 | scrub > "$EVIDENCE/repl-smoke.txt"
REPL_RC=$?
tail -12 "$EVIDENCE/repl-smoke.txt" | tee -a "$EVIDENCE/extras.txt"
echo "repl smoke exit: $REPL_RC" | tee -a "$EVIDENCE/extras.txt"

section "G. the agent can ask a question when someone is there to answer"
echo "only in interactive mode: an unattended question has no answer, so batch runs end the" | tee -a "$EVIDENCE/extras.txt"
echo "turn and say so rather than stalling until the timeout." | tee -a "$EVIDENCE/extras.txt"
python3 "$REPO/test/repl-questions.py" 2>&1 | scrub > "$EVIDENCE/repl-questions.txt"
QUESTION_RC=$?
tail -8 "$EVIDENCE/repl-questions.txt" | tee -a "$EVIDENCE/extras.txt"
echo "question flow exit: $QUESTION_RC" | tee -a "$EVIDENCE/extras.txt"

section "H. the project's own checks, run by moat against the agent's work"
capture verify $MOAT verify
echo "the exit code above is the project's own verdict on whatever is in the sandbox." | tee -a "$EVIDENCE/extras.txt"

section "I. bare moat in an empty, non-git directory: work, then apply, without leaving"
echo "the flow the tool exists for. A plain directory with nothing in it had no copy-out" | tee -a "$EVIDENCE/extras.txt"
echo "path at all before this: there is no host repository for git fetch to write into." | tee -a "$EVIDENCE/extras.txt"
python3 "$REPO/test/repl-apply.py" 2>&1 | scrub > "$EVIDENCE/repl-apply.txt"
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

section "K. model, reasoning effort and the other session controls"
echo "the choices opencode exposes that moat surfaces: pick a model, pick a reasoning" | tee -a "$EVIDENCE/extras.txt"
echo "level, pick an agent, compact, undo. Driven through a pty against the stub, so it" | tee -a "$EVIDENCE/extras.txt"
echo "checks moat's plumbing rather than any model's behaviour." | tee -a "$EVIDENCE/extras.txt"
python3 "$REPO/test/repl-controls.py" 2>&1 | scrub > "$EVIDENCE/repl-controls.txt"
CONTROLS_RC=$?
tail -16 "$EVIDENCE/repl-controls.txt" | tee -a "$EVIDENCE/extras.txt"
echo "controls exit: $CONTROLS_RC" | tee -a "$EVIDENCE/extras.txt"

section "L. the reasoning level chosen in the CLI reaches the provider"
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  echo "needs a real model: a stub reached through --base-url has no catalog metadata, so" | tee -a "$EVIDENCE/extras.txt"
  echo "it honestly has no effort levels to offer. The check reads the level the sandbox's" | tee -a "$EVIDENCE/extras.txt"
  echo "own server recorded on the assistant message, not moat's claim about itself." | tee -a "$EVIDENCE/extras.txt"
  python3 "$REPO/test/repl-effort.py" 2>&1 | scrub > "$EVIDENCE/repl-effort.txt"
  EFFORT_RC=$?
  tail -12 "$EVIDENCE/repl-effort.txt" | tee -a "$EVIDENCE/extras.txt"
  echo "effort exit: $EFFORT_RC" | tee -a "$EVIDENCE/extras.txt"
else
  echo "skipped: needs DEEPSEEK_API_KEY (it spends a few tokens on a real turn)" | tee -a "$EVIDENCE/extras.txt"
fi

section "M. the request body DeepSeek actually receives"
echo "every other check of the reasoning setting asks opencode what it thinks it did." | tee -a "$EVIDENCE/extras.txt"
echo "This one puts a recording proxy in front of the provider and reads the request:" | tee -a "$EVIDENCE/extras.txt"
echo "reasoning_effort for an effort, thinking.type=disabled for off. It uses --upstream," | tee -a "$EVIDENCE/extras.txt"
echo "which keeps DeepSeek's catalog definition and only moves the address." | tee -a "$EVIDENCE/extras.txt"
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  python3 "$REPO/test/wire-effort.py" 2>&1 | scrub > "$EVIDENCE/wire-effort.txt"
  WIRE_RC=$?
  tail -14 "$EVIDENCE/wire-effort.txt" | tee -a "$EVIDENCE/extras.txt"
  echo "wire check exit: $WIRE_RC" | tee -a "$EVIDENCE/extras.txt"
else
  echo "skipped: needs DEEPSEEK_API_KEY (it spends two short turns)" | tee -a "$EVIDENCE/extras.txt"
fi

section "N. an environment whose project directory is gone stays visible and reclaimable"

# The bug this guards: the inventory rebuilt an environment's paths from the
# project directory recorded in its state, through a realpath() that throws when
# that directory is gone. The environment was then dropped silently: `status
# --all` could not report it and `destroy --all` could not reclaim it. Two
# environments holding 800 MiB leaked that way. A throwaway MOAT_HOME keeps the
# real store out of a check that runs `destroy --all`.
ORPHAN_HOME=$(mktemp -d)
mkdir -p "$ORPHAN_HOME/envs/deadbeef1234/rootfs/usr" "$ORPHAN_HOME/envs/cafebabe5678"
printf 'x' > "$ORPHAN_HOME/envs/deadbeef1234/rootfs/usr/blob"
printf '{ "version": 1, "id": "deadbeef1234", "projectDir": "/gone/forever", "status": "stopped" }' > "$ORPHAN_HOME/envs/deadbeef1234/state.json"
printf 'not json at all' > "$ORPHAN_HOME/envs/cafebabe5678/state.json"
MOAT_HOME="$ORPHAN_HOME" $MOAT status --all > "$EVIDENCE/orphan-status.out" 2>&1
MOAT_HOME="$ORPHAN_HOME" $MOAT destroy --all > "$EVIDENCE/orphan-destroy.out" 2>&1
{
  echo "--- an environment whose project directory is gone, and one whose state is unreadable"
  echo "$ MOAT_HOME=<temporary> moat status --all"
  cat "$EVIDENCE/orphan-status.out"
  echo "$ MOAT_HOME=<temporary> moat destroy --all"
  cat "$EVIDENCE/orphan-destroy.out"
} | scrub > "$EVIDENCE/orphan-inventory.txt"
cat "$EVIDENCE/orphan-inventory.txt" | tee -a "$EVIDENCE/extras.txt"
ORPHANS_LEFT=$(ls "$ORPHAN_HOME/envs" | wc -l)
if grep -q "orphaned" "$EVIDENCE/orphan-status.out" && [ "$ORPHANS_LEFT" = "0" ]; then
  echo "orphan inventory: both were listed as orphaned and both were reclaimed" | tee -a "$EVIDENCE/extras.txt"
else
  echo "orphan inventory: FAILED, leftover directories: $ORPHANS_LEFT" | tee -a "$EVIDENCE/extras.txt"
fi
rm -rf "$ORPHAN_HOME"

section "O. every claim about process state is reconciled against the live process table"
capture status-final $MOAT status
capture down-final $MOAT down
if [ -f "$MOCK_PIDFILE" ]; then kill "$(cat "$MOCK_PIDFILE")" 2>/dev/null; fi

section "P. the boot log is readable through the guard that refuses symlinks"
# The box writes its output through a descriptor the host opened and verified
# (the script dups fd 3 instead of redirecting to a path inside the
# agent-writable rootfs), and the host reads it back through the same guard.
capture logs-sandbox $MOAT logs sandbox
if grep -q "sandbox boot" "$EVIDENCE/logs-sandbox.txt"; then
  echo "boot log: the banner the box wrote is readable back on the host" | tee -a "$EVIDENCE/extras.txt"
else
  echo "boot log: FAILED, no boot banner in the captured output" | tee -a "$EVIDENCE/extras.txt"
fi
section "Q. a project file name that is not valid UTF-8 is refused with a reason"
# Node addresses files by name as text, so a raw 0xff byte in a name is undecidable
# for every host-side walk. moat names the file and the bytes instead of failing
# later with ENOENT for a file that is plainly there.
BADNAME_PROJECT="$WORK/bad-name-project"
rm -rf "$BADNAME_PROJECT"
mkdir -p "$BADNAME_PROJECT"
cd "$BADNAME_PROJECT"
git init -q -b main
git config user.email e2e@example.com
git config user.name "E2E"
printf 'x' > "$(printf 'bad\xffname')"
git add -A >/dev/null 2>&1
git commit -qm "a name Node cannot address" >/dev/null 2>&1
capture up-badname $MOAT up
if grep -q "not a valid UTF-8 file name" "$EVIDENCE/up-badname.txt"; then
  echo "bad file name: refused with the offending bytes, before anything is copied" | tee -a "$EVIDENCE/extras.txt"
else
  echo "bad file name: FAILED, no explanation in the output" | tee -a "$EVIDENCE/extras.txt"
fi
capture destroy-badname $MOAT destroy --yes
cd "$PROJECT"

section "R. arguments that used to be joined into paths or trusted as numbers"
# These are cheap checks on the argument surface, not sandbox behaviour: `moat logs`
# joined argv into the environment's log directory (measured: a "../../../.."
# argument printed a host file outside the environment), `--tail abc` silently
# meant "the whole file", `moat models bogus` listed DeepSeek and exited 0, and a
# typo in `--port` survived provisioning to fail ninety seconds into a boot.
capture logs-traversal $MOAT logs ../../../../../tmp/moat-traversal
if grep -q "invalid log name" "$EVIDENCE/logs-traversal.txt"; then
  echo "log name: refused instead of reading a host file" | tee -a "$EVIDENCE/extras.txt"
else
  echo "log name: FAILED, no refusal in the output" | tee -a "$EVIDENCE/extras.txt"
fi

capture logs-bad-tail $MOAT logs sandbox --tail abc
if grep -q "must be a positive integer" "$EVIDENCE/logs-bad-tail.txt"; then
  echo "--tail: refused instead of silently printing the whole log" | tee -a "$EVIDENCE/extras.txt"
else
  echo "--tail: FAILED, no refusal in the output" | tee -a "$EVIDENCE/extras.txt"
fi

capture models-bogus $MOAT models bogus
if grep -q "one provider" "$EVIDENCE/models-bogus.txt"; then
  echo "models <provider>: refused instead of silently listing DeepSeek" | tee -a "$EVIDENCE/extras.txt"
else
  echo "models <provider>: FAILED, no refusal in the output" | tee -a "$EVIDENCE/extras.txt"
fi

capture up-bad-port $MOAT up --runtime opencode --port 99999
if grep -q "must be an integer between 1 and 65535" "$EVIDENCE/up-bad-port.txt"; then
  echo "--port: refused before provisioning, not ninety seconds into a boot" | tee -a "$EVIDENCE/extras.txt"
else
  echo "--port: FAILED, no refusal in the output" | tee -a "$EVIDENCE/extras.txt"
fi

capture up-timeout $MOAT up --runtime opencode --timeout 30
if grep -q "sandbox up" "$EVIDENCE/up-timeout.txt"; then
  echo "--timeout: seconds, not milliseconds, for the boot readiness wait" | tee -a "$EVIDENCE/extras.txt"
else
  echo "--timeout: FAILED, a 30-second budget did not cover a warm boot" | tee -a "$EVIDENCE/extras.txt"
fi
capture down-timeout $MOAT down

capture up-bad-tools $MOAT up --runtime opencode --tools bogus
if grep -q "unknown --tools" "$EVIDENCE/up-bad-tools.txt" && ! grep -q "provisioning" "$EVIDENCE/up-bad-tools.txt"; then
  echo "--tools: refused before provisioning" | tee -a "$EVIDENCE/extras.txt"
else
  echo "--tools: FAILED, the refusal came too late (or not at all)" | tee -a "$EVIDENCE/extras.txt"
fi

capture up-bad-log-level $MOAT up --runtime opencode --log-level chatty
if grep -q "unknown --log-level" "$EVIDENCE/up-bad-log-level.txt" && ! grep -q "provisioning" "$EVIDENCE/up-bad-log-level.txt"; then
  echo "--log-level: refused instead of silently becoming INFO" | tee -a "$EVIDENCE/extras.txt"
else
  echo "--log-level: FAILED, no early refusal" | tee -a "$EVIDENCE/extras.txt"
fi

capture up-empty-model $MOAT up --runtime opencode --model ""
if grep -q "needs a model id" "$EVIDENCE/up-empty-model.txt" && ! grep -q "provisioning" "$EVIDENCE/up-empty-model.txt"; then
  echo "--model with an empty value: refused" | tee -a "$EVIDENCE/extras.txt"
else
  echo "--model with an empty value: FAILED, no early refusal" | tee -a "$EVIDENCE/extras.txt"
fi

capture up-empty-base-url $MOAT up --runtime opencode --base-url ""
if grep -q "needs a URL" "$EVIDENCE/up-empty-base-url.txt" && ! grep -q "provisioning" "$EVIDENCE/up-empty-base-url.txt"; then
  echo "--base-url with an empty value: refused" | tee -a "$EVIDENCE/extras.txt"
else
  echo "--base-url with an empty value: FAILED, no early refusal" | tee -a "$EVIDENCE/extras.txt"
fi

section "S. the live view of a turn ends honestly when the event stream does"
# The REPL learns everything -- streamed text, tool rows, the question prompt and
# the session.idle that ends a turn -- from one long-lived response. Stop the box
# mid-turn and that response ends. The loop that read it used to catch the failure
# and say nothing: the spinner kept turning and every later line was answered with
# "queued" for a turn that was already over. This stops a real box underneath a
# real pty mid-turn, which is the reproduction, not a simulation of one.
echo "a pty session, a real box, a turn in flight, and then moat down underneath it." | tee -a "$EVIDENCE/extras.txt"
python3 "$REPO/test/repl-stream-loss.py" 2>&1 | scrub > "$EVIDENCE/repl-stream-loss.txt"
STREAM_RC=$?
tail -10 "$EVIDENCE/repl-stream-loss.txt" | tee -a "$EVIDENCE/extras.txt"
echo "stream loss exit: $STREAM_RC" | tee -a "$EVIDENCE/extras.txt"

section "T. an environment whose state.json is gone is recovered, not replaced"
# state.json is metadata; the environment is the rootfs. Reading a missing state as
# "nothing here" made `moat up` provision over the rootfs: measured, that destroyed a
# committed agent branch and an untracked file without a word, which also contradicts
# SPEC section 2.2 ("moat destroy is the only operation that deletes data"). This
# deletes the file for real, boots again, and then checks the work is still there.
STATELESS="$WORK/stateless"
rm -rf "$STATELESS"; mkdir -p "$STATELESS"
( cd "$STATELESS" && git init -q -b main . && printf '{"name":"stateless"}\n' > package.json \
  && git add -A && git -c user.email=e2e@example.com -c user.name=e2e commit -qm init )
( cd "$STATELESS" && capture stateless-up $MOAT up --runtime opencode --quiet --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
STATELESS_ENV=$(cd "$STATELESS" && $MOAT status 2>&1 | sed -n "s/^env *//p")
( cd "$STATELESS" && capture stateless-down $MOAT down )
# The agent's work, made the way the agent makes it: through a real boot of the same rootfs.
( cd "$STATELESS" && capture stateless-work $MOAT exec -- /bin/sh -c "cd /work && printf 'agent work\n' > precious.txt && git add -A && git -c user.email=agent@moat.invalid -c user.name=agent commit -qm 'agent: work the host has never seen' && git rev-parse HEAD" )
STATELESS_HEAD=$(sed -n "s/^\([0-9a-f]\{40\}\)$/\1/p" "$EVIDENCE/stateless-work.out" | tail -1)
rm -f "$STATELESS_ENV/state.json"
( cd "$STATELESS" && capture stateless-recover $MOAT up --runtime opencode --quiet --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
if grep -q "recovered from disk" "$EVIDENCE/stateless-recover.err" \
   && grep -q "reusing the sandbox working tree" "$EVIDENCE/stateless-recover.err" \
   && [ -f "$STATELESS_ENV/rootfs/work/precious.txt" ] \
   && [ -n "$STATELESS_HEAD" ]; then
  echo "state recovery: the rootfs was kept and its working tree reused, not re-copied" | tee -a "$EVIDENCE/extras.txt"
else
  echo "state recovery: FAILED, a missing state.json still replaces the environment" | tee -a "$EVIDENCE/extras.txt"
fi
# And the recovered environment is usable: the agent's commit reaches the host.
( cd "$STATELESS" && capture stateless-fetch $MOAT fetch --all )
if git -C "$STATELESS" cat-file -e "$STATELESS_HEAD" 2>/dev/null; then
  echo "state recovery: the recovered commit fetched to the host (refs/moat/*)" | tee -a "$EVIDENCE/extras.txt"
else
  echo "state recovery: FAILED, the recovered commit did not reach the host" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$STATELESS" && $MOAT destroy --yes >/dev/null 2>&1 )
section "U. a boot in progress is visible, and the lifecycle commands wait for it"
# A boot spends most of its time looking exactly like an idle environment: state.json
# still says stopped with no pid, because that is what it said before the boot began.
# Measured in that window: `moat down` printed "sandbox is not running" and the box then
# came up and stayed up; `moat destroy` deleted the rootfs out from under the boot; and a
# second `moat up` booted a second box over the same rootfs. The boot now writes a marker
# first, and this check polls for that marker rather than sleeping, so it acts inside the
# window whenever the window happens to be.
RACE="$WORK/race"
rm -rf "$RACE"; mkdir -p "$RACE"
( cd "$RACE" && git init -q -b main . && printf '{"name":"race"}\n' > package.json \
  && git add -A && git -c user.email=e2e@example.com -c user.name=e2e commit -qm init )
( cd "$RACE" && $MOAT destroy --yes >/dev/null 2>&1 )
RACE_ID=$( cd "$RACE" && node --input-type=module -e "import { envPaths } from '$REPO/lib/paths.ts'; console.log(envPaths(process.cwd()).id)" )
RACE_MARKER="$HOME/.moat/envs/$RACE_ID/runtime/boot.json"
( cd "$RACE" && $MOAT up --runtime opencode --quiet --no-detect --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL > "$EVIDENCE/race-up.out" 2> "$EVIDENCE/race-up.err" ) &
RACE_UP=$!
RACE_WAIT=0
while [ ! -f "$RACE_MARKER" ] && [ "$RACE_WAIT" -lt 300 ]; do sleep 0.1; RACE_WAIT=$((RACE_WAIT + 1)); done
if [ -f "$RACE_MARKER" ]; then
  echo "the boot marker appeared after ~$((RACE_WAIT / 10))s (state.json written yet: $([ -f "$HOME/.moat/envs/$RACE_ID/state.json" ] && echo yes || echo no))" | tee -a "$EVIDENCE/extras.txt"
else
  echo "boot marker: FAILED, no marker appeared within 30s" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$RACE" && capture race-status $MOAT status )
( cd "$RACE" && capture race-down $MOAT down )
wait "$RACE_UP"; RACE_UP_RC=$?
echo "the background moat up exited $RACE_UP_RC" | tee -a "$EVIDENCE/extras.txt"
if grep -q "booting (pid" "$EVIDENCE/race-status.txt"; then
  echo "status during a boot: reports booting, not stopped" | tee -a "$EVIDENCE/extras.txt"
else
  echo "status during a boot: FAILED, it did not mention the boot" | tee -a "$EVIDENCE/extras.txt"
fi
if grep -q "waiting for it before stopping the sandbox" "$EVIDENCE/race-down.txt" \
   && ! grep -q "is not running" "$EVIDENCE/race-down.txt" \
   && ! grep -q "no moat environment" "$EVIDENCE/race-down.txt"; then
  echo "down during a boot: waited for the boot and stopped what it produced" | tee -a "$EVIDENCE/extras.txt"
else
  echo "down during a boot: FAILED, it acted on the stale state instead of waiting" | tee -a "$EVIDENCE/extras.txt"
fi
RACE_STATE=$( cd "$RACE" && $MOAT status 2>&1 | sed -n "s/^status *//p" )
RACE_PROCS=$(ps -eo cmd | grep -c "[u]nshare --user.*$RACE_ID" || true)
if [ "$RACE_STATE" = "stopped" ] && [ "$RACE_PROCS" = "0" ] && [ ! -f "$RACE_MARKER" ]; then
  echo "after down: the box is stopped, nothing is left running, and the marker is gone" | tee -a "$EVIDENCE/extras.txt"
else
  echo "after down: FAILED, status=$RACE_STATE processes=$RACE_PROCS marker=$([ -f "$RACE_MARKER" ] && echo present || echo gone)" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$RACE" && $MOAT destroy --yes >/dev/null 2>&1 )
section "V. agent text cannot drive the terminal it is printed on"
# The answer, the reasoning, commit subjects, change paths and the sandbox log all come
# from inside the box, and a terminal reads escape sequences in them: OSC 0 retitles the
# window, OSC 52 writes the clipboard where the terminal allows it, CSI 2J clears the
# screen, and a carriage return overwrites the row. Tool output was already stripped; the
# model's own words were not. The pty test drives a real session with a distinct sequence
# in the answer, in a commit subject and in a file name; the check below writes one into
# the sandbox's own log, which the agent can write to at will, and reads it back.
python3 "$REPO/test/repl-escapes.py" 2>&1 | scrub > "$EVIDENCE/repl-escapes.txt"
ESCAPES_RC=$?
tail -10 "$EVIDENCE/repl-escapes.txt" | tee -a "$EVIDENCE/extras.txt"
echo "terminal escapes exit: $ESCAPES_RC" | tee -a "$EVIDENCE/extras.txt"

capture logs-inject $MOAT exec -- /bin/sh -c "printf 'LOG-INJECT \033]0;pwned-log\007 end\n' >> /var/log/moat/boot.log"
capture logs-escape $MOAT logs sandbox --tail 3
if grep -q "LOG-INJECT" "$EVIDENCE/logs-escape.txt" && ! grep -q "$(printf '\033]0;pwned-log')" "$EVIDENCE/logs-escape.txt"; then
  echo "sandbox log: the agent's own escape bytes are stripped, its text is not" | tee -a "$EVIDENCE/extras.txt"
else
  echo "sandbox log: FAILED, an escape sequence in the log reached the terminal" | tee -a "$EVIDENCE/extras.txt"
fi
section "W. a project with no tests is not reported as failing its tests"
# `npm init` writes `test: echo "Error: no test specified" && exit 1`. moat offered that
# as the project's own check: the agent was told to run it, and `moat verify` ran it and
# printed FAIL — a verdict on a test suite that does not exist. It is filtered now, so
# the honest answer is that this project declares no check at all.
NOTESTS="$WORK/notests"
rm -rf "$NOTESTS"; mkdir -p "$NOTESTS"
cat > "$NOTESTS/package.json" <<'EOF'
{
  "name": "notests",
  "scripts": { "test": "echo \"Error: no test specified\" && exit 1" }
}
EOF
( cd "$NOTESTS" && git init -q -b main . && git add -A && git -c user.email=e2e@example.com -c user.name=e2e commit -qm init )
( cd "$NOTESTS" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$NOTESTS" && capture notests-up $MOAT up --runtime opencode --quiet --no-detect --profile node --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
( cd "$NOTESTS" && capture notests-verify $MOAT verify )
if ! grep -q "checks:" "$EVIDENCE/notests-up.err" \
   && grep -q "no test, lint or typecheck command found" "$EVIDENCE/notests-verify.txt" \
   && grep -q "^--- exit 0$" "$EVIDENCE/notests-verify.txt"; then
  echo "no-tests project: nothing advertised as a check, and verify says so instead of failing" | tee -a "$EVIDENCE/extras.txt"
else
  echo "no-tests project: FAILED, npm's placeholder was still treated as a test suite" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$NOTESTS" && $MOAT destroy --yes >/dev/null 2>&1 )
section "X. the interactive /diff cannot run the agent's programs on the host"
# The sandbox repository is agent-controlled and git executes programs named by its
# config. `/diff` was the one host-side git call left outside the hardened runner, so
# the repository config was live for it: with log.showSignature=true and gpg.program
# pointed at a script inside /work (whose host path the agent reads from
# /proc/self/mountinfo), a commit carrying any gpgsig header made git run that script
# as the user the moment /diff was typed. The pty test plants exactly that and checks
# the script did not run while the diff still rendered.
python3 "$REPO/test/repl-diff-hardening.py" 2>&1 | scrub > "$EVIDENCE/repl-diff-hardening.txt"
DIFF_RC=$?
tail -8 "$EVIDENCE/repl-diff-hardening.txt" | tee -a "$EVIDENCE/extras.txt"
echo "diff hardening exit: $DIFF_RC" | tee -a "$EVIDENCE/extras.txt"
section "Y. --timeout shortens a check that hangs"
# `--timeout` is seconds everywhere and the checks runner takes it as timeoutSeconds,
# but neither `moat verify` nor `moat take` passed it: a suite that hangs ran to the
# ten-minute default, and the documented flag that should shorten it did nothing.
# The project here sleeps for three seconds; with --timeout 1 moat has to kill it,
# report it as timed out, and exit 1.
SLOW="$WORK/slowchecks"
rm -rf "$SLOW"; mkdir -p "$SLOW"
cat > "$SLOW/package.json" <<'EOF'
{
  "name": "slowchecks",
  "scripts": { "test": "sleep 3" }
}
EOF
( cd "$SLOW" && git init -q -b main . && git add -A && git -c user.email=e2e@example.com -c user.name=e2e commit -qm init )
( cd "$SLOW" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$SLOW" && capture slow-up $MOAT up --runtime opencode --quiet --no-detect --profile node --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
( cd "$SLOW" && capture slow-verify-default $MOAT verify )
( cd "$SLOW" && capture slow-verify-timeout $MOAT verify --timeout 1 )
SLOW_DUR=$(grep "npm test" "$EVIDENCE/slow-verify-timeout.txt" | grep -oE "[0-9]+\.[0-9]s" | head -1 | tr -d "s")
echo "the check itself was reported at ${SLOW_DUR}s (it sleeps 3; --timeout 1 was asked for)" | tee -a "$EVIDENCE/extras.txt"
if grep -q "^--- exit 0$" "$EVIDENCE/slow-verify-default.txt" \
   && grep -q "^--- exit 1$" "$EVIDENCE/slow-verify-timeout.txt" \
   && grep -q "timed out" "$EVIDENCE/slow-verify-timeout.txt" \
   && awk -v d="${SLOW_DUR:-99}" 'BEGIN{exit !(d < 2.5)}'; then
  echo "--timeout: a 3-second check is killed at 1s and reported as timed out" | tee -a "$EVIDENCE/extras.txt"
else
  echo "--timeout: FAILED, the flag did not shorten the check (reported ${SLOW_DUR}s)" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$SLOW" && $MOAT destroy --yes >/dev/null 2>&1 )
section "Z. a flag a command does not read is refused, and --quiet exists"
# The flag table is shared by every command, so a flag the command never reads used to
# be accepted and silently dropped: that is how --timeout never reached the checks
# runner (section Y) and how --quiet, which every harness here passes, was read by
# nothing at all. A flag is refused now, --quiet hides the progress lines, and a
# command with --help prints help instead of running.
capture flag-refused $MOAT fetch --timeout 5
if grep -q "^--- exit 1$" "$EVIDENCE/flag-refused.txt" \
   && grep -q -- "--timeout" "$EVIDENCE/flag-refused.txt" \
   && grep -q "refused rather than ignored" "$EVIDENCE/flag-refused.txt" \
   && ! grep -q "copy-out:" "$EVIDENCE/flag-refused.txt"; then
  echo "--timeout on fetch: refused before any work, not ignored" | tee -a "$EVIDENCE/extras.txt"
else
  echo "--timeout on fetch: FAILED, the flag was accepted or the command ran anyway" | tee -a "$EVIDENCE/extras.txt"
fi

capture down-before-z $MOAT down
capture loud-up $MOAT up --runtime opencode --no-detect --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL
capture down-mid-z $MOAT down
capture quiet-up $MOAT up --runtime opencode --quiet --no-detect --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL
if grep -q "^--- exit 0$" "$EVIDENCE/quiet-up.txt" && ! grep -q "→" "$EVIDENCE/quiet-up.txt"; then
  echo "--quiet: the boot printed no progress lines, and still succeeded" | tee -a "$EVIDENCE/extras.txt"
else
  echo "--quiet: FAILED, progress lines were still printed" | tee -a "$EVIDENCE/extras.txt"
fi
if grep -q "→" "$EVIDENCE/loud-up.txt"; then
  echo "the control without --quiet printed them, so the check above can fail" | tee -a "$EVIDENCE/extras.txt"
else
  echo "the control printed no progress lines: the --quiet check proves nothing" | tee -a "$EVIDENCE/extras.txt"
fi

capture help-flag $MOAT profiles --help
if grep -q "Usage: moat <command>" "$EVIDENCE/help-flag.txt" && ! grep -q "Node.js / TypeScript" "$EVIDENCE/help-flag.txt"; then
  echo "--help: prints the help text instead of running the command" | tee -a "$EVIDENCE/extras.txt"
else
  echo "--help: FAILED, the command ran instead of printing help" | tee -a "$EVIDENCE/extras.txt"
fi
section "AA. a port that is already taken is refused before provisioning"
# `--port` was checked for range but not for availability, so a port another process
# held cost the whole readiness budget (90 seconds by default) and failed with
# "opencode serve did not come up (GET /config -> TimeoutError)" — after provisioning
# and a copy-in had already run, and without naming the port. It is validated before
# provisioning now, like every other flag. The second half is the control: once the
# holder is gone the same port must work, so the check cannot pass by refusing all
# ports.
PORTBUSY="$WORK/portbusy"
rm -rf "$PORTBUSY"; mkdir -p "$PORTBUSY"
( cd "$PORTBUSY" && git init -q -b main . && printf '{"name":"portbusy"}\n' > package.json \
  && git add -A && git -c user.email=e2e@example.com -c user.name=e2e commit -qm init )
( cd "$PORTBUSY" && $MOAT destroy --yes >/dev/null 2>&1 )
HELD_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")
echo "holding port $HELD_PORT while moat is asked to use it" | tee -a "$EVIDENCE/extras.txt"
python3 -c "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',$HELD_PORT)); s.listen(1); time.sleep(120)" &
PORT_HOLDER=$!
sleep 1
( cd "$PORTBUSY" && capture port-busy $MOAT up --runtime opencode --quiet --no-detect --port "$HELD_PORT" --timeout 5 \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
kill "$PORT_HOLDER" 2>/dev/null
wait "$PORT_HOLDER" 2>/dev/null
if grep -q "already in use" "$EVIDENCE/port-busy.txt" \
   && grep -q "$HELD_PORT" "$EVIDENCE/port-busy.txt" \
   && grep -q "^--- exit 1$" "$EVIDENCE/port-busy.txt" \
   && ! grep -q "provisioning" "$EVIDENCE/port-busy.txt"; then
  echo "--port: a taken port is refused up front, naming the port and the address" | tee -a "$EVIDENCE/extras.txt"
else
  echo "--port: FAILED, the boot ran and failed later instead of refusing" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$PORTBUSY" && capture port-released $MOAT up --runtime opencode --quiet --no-detect --port "$HELD_PORT" --timeout 30 \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
if grep -q "^--- exit 0$" "$EVIDENCE/port-released.txt" && ! grep -q "already in use" "$EVIDENCE/port-released.txt"; then
  echo "the control: the same port boots once nothing holds it" | tee -a "$EVIDENCE/extras.txt"
else
  echo "the control FAILED: a free port was refused, so the check above proves nothing" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$PORTBUSY" && $MOAT destroy --yes >/dev/null 2>&1 )
section "AB. copy-out names a credential the agent could have committed"
# The agent has to read the injected credential to call the model, and the brief tells it
# not to commit it. Nothing checked: `moat fetch` copied every object the agent committed
# into the host repository, and `moat apply` wrote the agent's files into the working tree,
# with no scan at all — a key pasted into a config file travelled to the host and on to the
# next push. This boots a fixture, plants the exact value the box was given, and reads what
# copy-out says. The middle part is the control: clean content must stay quiet, or the
# warning is noise nobody reads.
LEAK="$WORK/leakscan"
rm -rf "$LEAK"; mkdir -p "$LEAK"
( cd "$LEAK" && git init -q -b main . && printf '{"name":"leakscan"}\n' > package.json \
  && git add -A && git -c user.email=e2e@example.com -c user.name=e2e commit -qm init )
( cd "$LEAK" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$LEAK" && capture leak-up $MOAT up --runtime opencode --quiet --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
# Control first: an ordinary commit, no credential anywhere in it.
( cd "$LEAK" && $MOAT exec -- /bin/sh -c 'printf "export const x = 1\n" > /work/feature.ts \
  && git -C /work -c user.email=a@b -c user.name=agent add -A \
  && git -C /work -c user.email=a@b -c user.name=agent commit -qm "clean change"' >/dev/null 2>&1 )
export MOAT_CREDENTIAL="$CREDENTIAL"
( cd "$LEAK" && capture leak-fetch-clean $MOAT fetch )
# The same commit path, with the value the box was booted with written into the project.
( cd "$LEAK" && $MOAT exec -- /bin/sh -c "printf 'DEEPSEEK_API_KEY=%s\n' '$CREDENTIAL' > /work/leaked.env \
  && git -C /work -c user.email=a@b -c user.name=agent add -A \
  && git -C /work -c user.email=a@b -c user.name=agent commit -qm 'oops, the key'" >/dev/null 2>&1 )
( cd "$LEAK" && capture leak-fetch $MOAT fetch )
( cd "$LEAK" && capture leak-apply $MOAT apply )
unset MOAT_CREDENTIAL

{
  echo "$ grep -c 'credential moat injected' leak-fetch-clean.txt    # the control, expect 0"
  grep -c "credential moat injected" "$EVIDENCE/leak-fetch-clean.txt" || true
  echo ""
  echo "$ grep -B1 leaked.env leak-fetch.txt"
  grep -B1 "leaked.env" "$EVIDENCE/leak-fetch.txt" || true
  echo ""
  echo "$ grep -B1 leaked.env leak-apply.txt"
  grep -B1 "leaked.env" "$EVIDENCE/leak-apply.txt" || true
  echo ""
  echo "$ test -f $LEAK/leaked.env    # named, not blocked: the user asked for the work"
  if [ -f "$LEAK/leaked.env" ]; then echo "the file was still written to the host tree"; else echo "MISSING"; fi
} | scrub | tee -a "$EVIDENCE/extras.txt"

if grep -q "credential moat injected" "$EVIDENCE/leak-fetch.txt" \
   && grep -q "leaked.env" "$EVIDENCE/leak-fetch.txt" \
   && grep -q "credential moat injected" "$EVIDENCE/leak-apply.txt" \
   && grep -q "leaked.env" "$EVIDENCE/leak-apply.txt" \
   && [ -f "$LEAK/leaked.env" ] \
   && ! grep -q "credential moat injected" "$EVIDENCE/leak-fetch-clean.txt"; then
  echo "copy-out: fetch and apply both name the credential in the agent's commit, and the" | tee -a "$EVIDENCE/extras.txt"
  echo "          clean commit stays quiet; the file is still applied (a warning, not a gate)" | tee -a "$EVIDENCE/extras.txt"
else
  echo "copy-out: FAILED — either the leak was silent, or clean content warned" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$LEAK" && $MOAT destroy --yes >/dev/null 2>&1 )
section "AC. a base URL the sandbox cannot use is refused before provisioning"
# `new URL()` is a parse check, not a usability check. `localhost:11434/v1` — the
# scheme-less form of the endpoint moat's own error text suggests — parses as protocol
# "localhost:" with an empty hostname, so providerHost() and providerProbe() both return
# undefined. Measured before the fix: `moat up` provisioned, copied in and booted a
# *filtered* sandbox whose allowlist contained no provider address (exit 0), every model
# call the agent made would fail, and `moat doctor` printed "the provider is reachable"
# for a probe it never ran.
NB="$WORK/nobase"
rm -rf "$NB"; mkdir -p "$NB"
( cd "$NB" && git init -q -b main . && printf '{"name":"nobase"}\n' > package.json \
  && git add -A && git -c user.email=e2e@example.com -c user.name=e2e commit -qm init )
( cd "$NB" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$NB" && capture base-url-schemeless $MOAT up --runtime opencode --quiet --no-detect --model mock-model \
  --base-url "localhost:$MOCK_PORT/v1" )
# "image provisioned" and "copy-in via" are success lines, so --quiet cannot hide them:
# their absence is what proves the refusal happened before any work was done.
if grep -q "must be an http:// or https:// URL" "$EVIDENCE/base-url-schemeless.txt" \
   && grep -q "did you mean http://localhost:$MOCK_PORT/v1" "$EVIDENCE/base-url-schemeless.txt" \
   && grep -q "^--- exit 1$" "$EVIDENCE/base-url-schemeless.txt" \
   && ! grep -qE "image provisioned|copy-in via" "$EVIDENCE/base-url-schemeless.txt"; then
  echo "base-url: refused before provisioning, naming the problem and the likely fix" | tee -a "$EVIDENCE/extras.txt"
else
  echo "base-url: FAILED, the unusable URL was accepted or the refusal came too late" | tee -a "$EVIDENCE/extras.txt"
fi
# The control: the same host and port with the scheme boots, so the check above cannot
# pass by refusing every --base-url.
( cd "$NB" && capture base-url-schemed $MOAT up --runtime opencode --quiet --no-detect --model mock-model \
  --base-url "http://localhost:$MOCK_PORT/v1" )
if grep -q "^--- exit 0$" "$EVIDENCE/base-url-schemed.txt" && grep -q "sandbox up" "$EVIDENCE/base-url-schemed.txt"; then
  echo "the control: the same endpoint with a scheme boots" | tee -a "$EVIDENCE/extras.txt"
else
  echo "the control FAILED: a usable URL was refused" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$NB" && $MOAT destroy --yes >/dev/null 2>&1 )
section "AD. a re-copy cannot silently discard work on another sandbox branch"
# countUnfetched looked only at the sandbox's HEAD, so a commit on a side branch was
# invisible to the drift check: after the host project changed, `moat up` re-copied over
# it — the branch, the commit and the file were gone — while the warning said the sandbox
# "holds nothing that is not already on the host". Measured before the fix. The same
# undercount disabled the --fresh gate, which is meant to demand --yes when the box holds
# unfetched work.
BL="$WORK/branchloss"
rm -rf "$BL"; mkdir -p "$BL"
( cd "$BL" && git init -q -b main . && printf 'base\n' > base.txt && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base )
( cd "$BL" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$BL" && capture branchloss-up $MOAT up --runtime opencode --quiet --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
# The agent leaves work on a branch it is not standing on: the case HEAD-only counting missed.
( cd "$BL" && $MOAT exec -- /bin/sh -c 'BASE=$(git -C /work rev-parse --abbrev-ref HEAD); \
  git -C /work checkout -q -b experiment; echo important > /work/experiment.txt; \
  git -C /work add -A; git -C /work -c user.email=a@b -c user.name=agent commit -qm "important work on a side branch"; \
  git -C /work checkout -q "$BASE"' >/dev/null 2>&1 )
( cd "$BL" && $MOAT down >/dev/null 2>&1 )
( cd "$BL" && echo changed-on-the-host >> base.txt )
( cd "$BL" && capture branchloss-up-again $MOAT up --runtime opencode --quiet --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
( cd "$BL" && capture branchloss-branches $MOAT exec -- /bin/sh -c \
  'git -C /work branch; echo "--- all commits ---"; git -C /work log --oneline --all | head -4' )
if grep -q "sandbox holds 1 commit(s)" "$EVIDENCE/branchloss-up-again.txt" \
   && grep -q "reusing the sandbox working tree" "$EVIDENCE/branchloss-up-again.txt" \
   && grep -q "experiment" "$EVIDENCE/branchloss-branches.txt" \
   && grep -q "important work on a side branch" "$EVIDENCE/branchloss-branches.txt"; then
  echo "side branch: a sandbox holding unfetched work is kept, and the warning names it" | tee -a "$EVIDENCE/extras.txt"
else
  echo "side branch: FAILED — the re-copy discarded it, or nothing said so" | tee -a "$EVIDENCE/extras.txt"
fi
# The control: once the work *is* on the host (fetched), the same host change re-copies
# automatically — the guard must not block the lossless path it exists for.
( cd "$BL" && $MOAT fetch --all >/dev/null 2>&1 )
( cd "$BL" && $MOAT down >/dev/null 2>&1 )
( cd "$BL" && echo changed-again >> base.txt )
( cd "$BL" && capture branchloss-fetched $MOAT up --runtime opencode --quiet --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
if grep -q "holds nothing that is not already on the host" "$EVIDENCE/branchloss-fetched.txt" \
   && grep -q "copy-in via git" "$EVIDENCE/branchloss-fetched.txt"; then
  echo "the control: fetched work is re-copied over, because the host already has it" | tee -a "$EVIDENCE/extras.txt"
else
  echo "the control FAILED: a lossless re-copy was blocked" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$BL" && $MOAT destroy --yes >/dev/null 2>&1 )
section "AE. a commit on a detached HEAD in the sandbox is named, not discarded"
# countUnfetched took every branch and tag tip but not HEAD itself, so work committed on a
# detached HEAD was invisible: the drift re-copy destroyed it while saying the sandbox held
# nothing, and `moat fetch` could not have collected it either (it reads branches). Measured
# before the fix: the commit and its file were gone.
DET="$WORK/detached"
rm -rf "$DET"; mkdir -p "$DET"
( cd "$DET" && git init -q -b main . && printf 'base\n' > base.txt && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base )
( cd "$DET" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$DET" && capture detached-up $MOAT up --runtime opencode --quiet --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
( cd "$DET" && $MOAT exec -- /bin/sh -c 'git -C /work checkout -q --detach HEAD; \
  echo important > /work/detached.txt; git -C /work add -A; \
  git -C /work -c user.email=a@b -c user.name=agent commit -qm "work on a detached HEAD"' >/dev/null 2>&1 )
( cd "$DET" && $MOAT down >/dev/null 2>&1 )
( cd "$DET" && echo changed-on-the-host >> base.txt )
( cd "$DET" && capture detached-up-again $MOAT up --runtime opencode --quiet --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
( cd "$DET" && capture detached-log $MOAT exec -- /bin/sh -c \
  'git -C /work log --oneline --all | head -4; echo "--- detached.txt ---"; ls /work/detached.txt' )
# The way out the warning names: put it on a branch, then fetch that branch.
( cd "$DET" && $MOAT exec -- /bin/sh -c 'git -C /work branch keep' >/dev/null 2>&1 )
( cd "$DET" && capture detached-fetch $MOAT fetch keep )
if grep -q "sandbox holds 1 commit(s)" "$EVIDENCE/detached-up-again.txt" \
   && grep -q "detached HEAD" "$EVIDENCE/detached-up-again.txt" \
   && grep -q "reusing the sandbox working tree" "$EVIDENCE/detached-up-again.txt" \
   && grep -q "work on a detached HEAD" "$EVIDENCE/detached-log.txt" \
   && grep -q "detached.txt" "$EVIDENCE/detached-log.txt" \
   && git -C "$DET" rev-parse --verify --quiet refs/moat/keep >/dev/null; then
  echo "detached HEAD: the commit is kept, and the warning names how to fetch it" | tee -a "$EVIDENCE/extras.txt"
else
  echo "detached HEAD: FAILED — the commit was discarded, or nothing said so" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$DET" && $MOAT destroy --yes >/dev/null 2>&1 )
section "AF. a local endpoint runs with no credential in the box"
# SPEC §1.3 recommends `moat up --no-credential` when you want nothing stealable in the
# box. With --base-url that used to fail silently: the provider base URL and model were
# injected only as part of the credential, so the box had an empty base URL and every
# call died inside it with ERR_INVALID_URL ("/chat/completions" cannot be parsed as a
# URL) while the host printed nothing but "0 tool calls". The task guard refused the very
# path its own message recommended. The native provider must still refuse a task with no
# key: there the key *is* the model.
AF_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")
rm -f "$WORK/af-mock.jsonl"
setsid node "$REPO/test/mock-model.mjs" --port "$AF_PORT" --script "$REPO/test/scripts/basic.json" \
  --record "$WORK/af-mock.jsonl" > "$WORK/af-mock.log" 2>&1 < /dev/null &
AF_MOCK=$!
sleep 1.2
NC="$WORK/nocred"
rm -rf "$NC"; mkdir -p "$NC"
( cd "$NC" && git init -q -b main . && printf 'readme\n' > README.md && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base )
( cd "$NC" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$NC" && capture nocred-local $MOAT run --runtime opencode --no-credential --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$AF_PORT/v1" "do the task" )
python3 - "$WORK/af-mock.jsonl" > "$WORK/nocred-auth.txt" <<'PYEOF'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1])]
auth = sorted({json.dumps(row.get("authorization")) for row in rows})
print(f"requests this run: {len(rows)}")
print(f"authorization headers: {', '.join(auth) if auth else '(none)'}")
PYEOF
echo "--- what the local endpoint received ---" | tee -a "$EVIDENCE/extras.txt"
cat "$WORK/nocred-auth.txt" | tee -a "$EVIDENCE/extras.txt"
if grep -q "^--- exit 0$" "$EVIDENCE/nocred-local.txt" \
   && grep -q "Task complete" "$EVIDENCE/nocred-local.txt" \
   && grep -q "no credential injected" "$EVIDENCE/nocred-local.txt" \
   && grep -q "requests this run: 6" "$WORK/nocred-auth.txt" \
   && grep -q "authorization headers: null" "$WORK/nocred-auth.txt"; then
  echo "no credential: the local endpoint runs the task, and no key is sent to it" | tee -a "$EVIDENCE/extras.txt"
else
  echo "no credential: FAILED — the endpoint was unreachable, or a credential went with it" | tee -a "$EVIDENCE/extras.txt"
fi
kill "$AF_MOCK" 2>/dev/null; wait "$AF_MOCK" 2>/dev/null
# Control: the native provider cannot work without a key, and still says so before booting.
NATIVE="$WORK/nocred-native"
rm -rf "$NATIVE"; mkdir -p "$NATIVE"
( cd "$NATIVE" && git init -q -b main . && printf 'readme\n' > README.md && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base )
( cd "$NATIVE" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$NATIVE" && capture nocred-native $MOAT run --runtime opencode --no-credential --no-detect --model deepseek-flash "do the task" )
if grep -q "no DEEPSEEK_API_KEY, so the agent has no model to call" "$EVIDENCE/nocred-native.txt" \
   && grep -q "^--- exit 1$" "$EVIDENCE/nocred-native.txt" \
   && ! grep -q "sandbox up" "$EVIDENCE/nocred-native.txt"; then
  echo "the control: the native provider still refuses a task with no key, before booting" | tee -a "$EVIDENCE/extras.txt"
else
  echo "the control FAILED: a keyless native run was attempted" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$NC" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$NATIVE" && $MOAT destroy --yes >/dev/null 2>&1 )
section "AG. a datapath whose box is gone is reaped, not orphaned"
# The slirp4netns datapath is a separate process, and only a command holding its pid on
# record can reap it. A box killed out of band (OOM, host reboot, kill -9) left its datapath
# running; the next `moat up` booted a second one and overwrote state.json, so the old one
# became unattributable and outlived even `moat destroy`. Measured before the fix: one
# kill -9, then `moat up` left two slirp4netns processes, and destroy took only one.
KD="$WORK/killed"
rm -rf "$KD"; mkdir -p "$KD"
( cd "$KD" && git init -q -b main . && printf 'x\n' > a.txt && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base )
( cd "$KD" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$KD" && capture killed-up $MOAT up --runtime opencode --quiet --no-detect --no-credential --egress isolated \
  --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" )
( cd "$KD" && capture killed-status $MOAT status --json )
KSTATE=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['envDir'])" "$EVIDENCE/killed-status.out")/state.json
OLD_BOX=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['pid'])" "$KSTATE")
OLD_SLIRP=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['slirpPid'])" "$KSTATE")
# The binary path is slirp4netns-<version>, so there is no space after the name.
count_datapath() { ps -eo args | grep -c "[s]lirp4netns.* $1 tap0"; }
echo "box $OLD_BOX, datapath $OLD_SLIRP" | tee -a "$EVIDENCE/extras.txt"
kill -9 "$OLD_BOX" 2>/dev/null
sleep 1
ORPHAN_BEFORE=$(count_datapath "$OLD_BOX")
echo "datapath for that box still up one second after the kill: $ORPHAN_BEFORE" | tee -a "$EVIDENCE/extras.txt"
( cd "$KD" && capture killed-up-again $MOAT up --runtime opencode --quiet --no-detect --no-credential --egress isolated \
  --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" )
NEW_BOX=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['pid'])" "$KSTATE")
OLD_LEFT=$(count_datapath "$OLD_BOX")
NEW_UP=$(count_datapath "$NEW_BOX")
echo "after the second boot: old datapath $OLD_LEFT, new datapath $NEW_UP (new box $NEW_BOX)" | tee -a "$EVIDENCE/extras.txt"
( cd "$KD" && $MOAT destroy --yes >/dev/null 2>&1 )
AFTER_DESTROY=$(count_datapath "$NEW_BOX")
# Half one, the outcome: no datapath for the dead box survives, and the new one is
# reclaimed. This holds whether the datapath exited on its own or was reaped.
if [ "$OLD_LEFT" = "0" ] && [ "$NEW_UP" = "1" ] && [ "$AFTER_DESTROY" = "0" ]; then
  echo "out-of-band kill: no orphaned datapath survives the next boot, and destroy takes the rest" | tee -a "$EVIDENCE/extras.txt"
else
  echo "out-of-band kill: FAILED — old=$OLD_LEFT new=$NEW_UP after-destroy=$AFTER_DESTROY" | tee -a "$EVIDENCE/extras.txt"
fi
# Half two, deterministic: the datapath can exit by itself when the box dies (it notices
# the tap going away), which would leave the reap itself untested. So keep the box alive and
# make its recorded identity stale instead — the state a reboot with pid reuse leaves — and
# the datapath is certainly running when the next boot decides.
( cd "$KD" && capture reaped-up $MOAT up --runtime opencode --quiet --no-detect --no-credential --egress isolated \
  --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" )
python3 - "$KSTATE" <<'PYEOF'
import json, sys
path = sys.argv[1]
state = json.load(open(path))
state["pidStart"] = "not-the-process-that-is-running"
json.dump(state, open(path, "w"), indent=2)
print("recorded identity replaced; box", state["pid"], "datapath", state["slirpPid"])
PYEOF
LIVE_BOX=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['pid'])" "$KSTATE")
LIVE_SLIRP=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['slirpPid'])" "$KSTATE")
echo "datapath up while its box is still alive: $(count_datapath "$LIVE_BOX")" | tee -a "$EVIDENCE/extras.txt"
( cd "$KD" && capture reaped-up-again $MOAT up --runtime opencode --quiet --no-detect --no-credential --egress isolated \
  --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" )
REAPED_LEFT=$(count_datapath "$LIVE_BOX")
if grep -q "reaped the datapath of a sandbox that is no longer running (pid $LIVE_SLIRP)" "$EVIDENCE/reaped-up-again.txt" \
   && [ "$REAPED_LEFT" = "0" ]; then
  echo "stale identity: the datapath of a box that is not ours is reaped, and named" | tee -a "$EVIDENCE/extras.txt"
else
  echo "stale identity: FAILED — datapath left=$REAPED_LEFT" | tee -a "$EVIDENCE/extras.txt"
fi
# The old box could not be reaped (its identity was tampered with on purpose), so end it
# here; its datapath is already gone.
kill -9 -- "-$LIVE_BOX" 2>/dev/null
( cd "$KD" && $MOAT destroy --yes >/dev/null 2>&1 )
# Half three: `down` and `destroy` hold the only record of a datapath too. A box whose
# recorded identity is stale — what a reboot with pid reuse leaves — is one they refuse to
# signal, and both used to clear or delete the record without stopping the process.
# Measured before the fix: `moat down` printed "the recorded sandbox is gone", set slirpPid
# to null, and left the slirp4netns process running with nothing on disk naming it.
stale_identity() {
  python3 - "$1" <<'PYEOF'
import json, sys
path = sys.argv[1]
state = json.load(open(path))
state["pidStart"] = "not-the-process-that-is-running"
json.dump(state, open(path, "w"), indent=2)
PYEOF
}
REAP_ENV="$WORK/datapath-reap"
rm -rf "$REAP_ENV"; mkdir -p "$REAP_ENV"
( cd "$REAP_ENV" && git init -q -b main . && printf 'x\n' > a.txt && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base )
( cd "$REAP_ENV" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$REAP_ENV" && capture reap-down-up $MOAT up --runtime opencode --quiet --no-detect --no-credential --egress isolated \
  --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" )
( cd "$REAP_ENV" && capture reap-down-status $MOAT status --json )
DSTATE=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['envDir'])" "$EVIDENCE/reap-down-status.out")/state.json
DBOX=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['pid'])" "$DSTATE")
DSLIRP=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['slirpPid'])" "$DSTATE")
echo "down half: box $DBOX, datapath $DSLIRP, up before: $(count_datapath "$DBOX")" | tee -a "$EVIDENCE/extras.txt"
stale_identity "$DSTATE"
( cd "$REAP_ENV" && capture reap-down $MOAT down )
DOWN_LEFT=$(count_datapath "$DBOX")
DOWN_RECORD=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['slirpPid'])" "$DSTATE")
if [ "$DOWN_LEFT" = "0" ] && [ "$DOWN_RECORD" = "None" ] \
   && grep -q "reaped the datapath of a sandbox that is no longer running (pid $DSLIRP)" "$EVIDENCE/reap-down.txt"; then
  echo "down: a datapath the recorded box cannot be signalled for is reaped, named, then forgotten" | tee -a "$EVIDENCE/extras.txt"
else
  echo "down: FAILED — datapath left=$DOWN_LEFT recorded=$DOWN_RECORD" | tee -a "$EVIDENCE/extras.txt"
fi
kill -9 -- "-$DBOX" 2>/dev/null
( cd "$REAP_ENV" && $MOAT destroy --yes >/dev/null 2>&1 )

# Half four: `destroy` deletes the environment, so the record goes with the directory.
( cd "$REAP_ENV" && capture reap-destroy-up $MOAT up --runtime opencode --quiet --no-detect --no-credential --egress isolated \
  --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" )
( cd "$REAP_ENV" && capture reap-destroy-status $MOAT status --json )
DSTATE=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['envDir'])" "$EVIDENCE/reap-destroy-status.out")/state.json
DENVDIR=$(dirname "$DSTATE")
XBOX=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['pid'])" "$DSTATE")
XSLIRP=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['slirpPid'])" "$DSTATE")
stale_identity "$DSTATE"
( cd "$REAP_ENV" && capture reap-destroy $MOAT destroy --yes )
DEST_LEFT=$(count_datapath "$XBOX")
if [ "$DEST_LEFT" = "0" ] && [ ! -e "$DENVDIR" ] \
   && grep -q "reaped the datapath of a sandbox that is no longer running (pid $XSLIRP)" "$EVIDENCE/reap-destroy.txt"; then
  echo "destroy: the environment is removed and its datapath with it" | tee -a "$EVIDENCE/extras.txt"
else
  echo "destroy: FAILED — datapath left=$DEST_LEFT envdir=$([ -e "$DENVDIR" ] && echo present || echo gone)" | tee -a "$EVIDENCE/extras.txt"
fi
kill -9 -- "-$XBOX" 2>/dev/null

# Half five: `restore` clears the datapath fields for a box it will not signal.
( cd "$REAP_ENV" && capture reap-restore-up $MOAT up --runtime opencode --quiet --no-detect --no-credential --egress isolated \
  --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" )
( cd "$REAP_ENV" && capture reap-restore-status $MOAT status --json )
DSTATE=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['envDir'])" "$EVIDENCE/reap-restore-status.out")/state.json
RBOX=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['pid'])" "$DSTATE")
RSLIRP=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['slirpPid'])" "$DSTATE")
( cd "$REAP_ENV" && capture reap-restore-snapshot $MOAT snapshot reap-base --yes )
stale_identity "$DSTATE"
( cd "$REAP_ENV" && capture reap-restore $MOAT restore reap-base --yes )
REST_LEFT=$(count_datapath "$RBOX")
if [ "$REST_LEFT" = "0" ] \
   && grep -q "reaped the datapath of a sandbox that is no longer running (pid $RSLIRP)" "$EVIDENCE/reap-restore.txt"; then
  echo "restore: the datapath is reaped before the record that names it is cleared" | tee -a "$EVIDENCE/extras.txt"
else
  echo "restore: FAILED — datapath left=$REST_LEFT" | tee -a "$EVIDENCE/extras.txt"
fi
kill -9 -- "-$RBOX" 2>/dev/null
( cd "$REAP_ENV" && $MOAT destroy --yes >/dev/null 2>&1 )
section "AH. the doctor reports the credential state the box actually has"
# The probe injects the credential *names* so the environment check models the real box, but
# it injected all of them unconditionally: a box booted with --no-credential — the "nothing
# stealable in the box" mode — was told "credential visible to the agent" and shown
# DEEPSEEK_API_KEY and MOAT_INJECTED_CREDENTIAL that existed only inside the probe, and a
# custom endpoint was told it had DEEPSEEK_API_KEY, which it never has. The list now comes
# from the environment's own state.
NL="$WORK/nocred-doctor"
rm -rf "$NL"; mkdir -p "$NL"
( cd "$NL" && git init -q -b main . && printf 'x\n' > a.txt && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base )
( cd "$NL" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$NL" && capture nocred-doctor-up $MOAT up --runtime opencode --quiet --no-detect --no-credential --egress isolated --model deepseek-flash )
( cd "$NL" && capture nocred-doctor $MOAT doctor )
if grep -q "no variable from the host environment reached the sandbox" "$EVIDENCE/nocred-doctor.txt" \
   && ! grep -E "reached the sandbox.*DEEPSEEK_API_KEY" "$EVIDENCE/nocred-doctor.txt" \
   && ! grep -q "which is the credential" "$EVIDENCE/nocred-doctor.txt" \
   && grep -q "None of them is a provider credential" "$EVIDENCE/nocred-doctor.txt" \
   && ! grep -q "spend-capped" "$EVIDENCE/nocred-doctor.txt"; then
  echo "no-credential box: the doctor reports no key in the box, and does not invent one" | tee -a "$EVIDENCE/extras.txt"
else
  echo "no-credential box: FAILED — the doctor's report does not match the box" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$NL" && $MOAT destroy --yes >/dev/null 2>&1 )
# The control: a box that does have a credential keeps the exposure, names which variable is
# the credential, and does not claim the native provider's variable for a custom endpoint.
CL="$WORK/cred-doctor"
rm -rf "$CL"; mkdir -p "$CL"
( cd "$CL" && git init -q -b main . && printf 'x\n' > a.txt && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base )
( cd "$CL" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$CL" && capture cred-doctor-up $MOAT up --runtime opencode --quiet --no-detect --egress isolated --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
( cd "$CL" && capture cred-doctor $MOAT doctor )
grep "are in the environment tool execution inherits" "$EVIDENCE/cred-doctor.txt" > "$WORK/cred-doctor-detail.txt" || true
if grep -qE "of which .*MOAT_INJECTED_CREDENTIAL.*is the credential" "$EVIDENCE/cred-doctor.txt" \
   && grep -q "spend-capped token" "$WORK/cred-doctor-detail.txt" \
   && ! grep -E "reached the sandbox.*DEEPSEEK_API_KEY" "$EVIDENCE/cred-doctor.txt" \
   && ! grep -q "DEEPSEEK_API_KEY" "$WORK/cred-doctor-detail.txt"; then
  echo "the control: a box with a credential still reports it, and names which variable it is" | tee -a "$EVIDENCE/extras.txt"
else
  echo "the control FAILED: a credentialed box's exposure was lost or misnamed" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$CL" && $MOAT destroy --yes >/dev/null 2>&1 )
section "AI. the project's own check output cannot drive the terminal it is printed on"
# A check is the project's own command and the agent can edit it, so its output is sandbox
# text like any other: OSC 0 retitles the window, OSC 52 writes the clipboard, CSI 2J clears
# the screen. `moat verify` streamed the bytes straight to stderr and `moat take` printed them
# in its failure listing — in the two commands the user runs *instead of* trusting the agent.
# Measured before the fix: a failing test script put four raw ESC bytes on the terminal.
ESC_PROJECT="$WORK/escape-check"
rm -rf "$ESC_PROJECT"; mkdir -p "$ESC_PROJECT"
cat > "$ESC_PROJECT/escape.js" <<'EOF'
process.stdout.write("\u001b]0;PWNED-TITLE\u0007\u001b[2JMOAT-CHECK-MARKER\n");
process.stderr.write("\u001b[31mred-text\u001b[0m\n");
process.exit(1);
EOF
printf '{"name":"escape-check","version":"1.0.0","scripts":{"test":"node escape.js"}}\n' > "$ESC_PROJECT/package.json"
( cd "$ESC_PROJECT" && git init -q -b main . && git config user.email e2e@example.com && git config user.name e2e \
  && git add -A && git commit -qm base )
( cd "$ESC_PROJECT" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$ESC_PROJECT" && capture escape-up $MOAT up --runtime opencode --quiet --no-credential --egress isolated --profile node --model deepseek-flash )
( cd "$ESC_PROJECT" && capture escape-verify $MOAT verify )
( cd "$ESC_PROJECT" && capture escape-take $MOAT take )
python3 - "$EVIDENCE" <<'PYEOF' > "$WORK/escape-bytes.txt"
import pathlib, sys
evidence = pathlib.Path(sys.argv[1])
for name in ("escape-verify", "escape-take"):
    data = (evidence / f"{name}.err").read_bytes()
    print(f"{name}: {len(data)} stderr bytes, {data.count(chr(27).encode())} ESC byte(s), marker present: {b'MOAT-CHECK-MARKER' in data}")
PYEOF
cat "$WORK/escape-bytes.txt" | tee -a "$EVIDENCE/extras.txt"
if grep -q "escape-verify: .* 0 ESC byte(s), marker present: True" "$WORK/escape-bytes.txt" \
   && grep -q "escape-take: .* 0 ESC byte(s), marker present: True" "$WORK/escape-bytes.txt"; then
  echo "check output: escapes are dropped, and the text around them still reaches the user" | tee -a "$EVIDENCE/extras.txt"
else
  echo "check output: FAILED — an escape byte reached the terminal, or the output was dropped" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$ESC_PROJECT" && $MOAT destroy --yes >/dev/null 2>&1 )
section "AJ. the codex runtime is the default, and a switch keeps /work"
# Codex ships a musl binary in its npm platform tarball, so it runs on the Alpine image with no
# gcompat and no Node runtime. The default runtime is codex; the image carries only the runtime
# an environment was created with, so switching installs the other one into the live rootfs.
# Re-provisioning is not an option: it deletes the rootfs first, which takes /work with it
# (measured: an untracked file was lost that way before this was written).
CDX="$WORK/codex-runtime"
rm -rf "$CDX"; mkdir -p "$CDX"
( cd "$CDX" && git init -q -b main . && printf 'x\n' > a.txt && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base )
( cd "$CDX" && $MOAT destroy --yes >/dev/null 2>&1 )
CODEX_VERSION=$(node -e "import('$REPO/lib/pins.ts').then((m) => console.log(m.CODEX_VERSION))")
( cd "$CDX" && capture codex-up $MOAT up --quiet --no-detect --no-credential )
( cd "$CDX" && capture codex-status $MOAT status )
( cd "$CDX" && capture codex-config $MOAT exec -- sh -c 'codex --version; cat /root/.codex/config.toml; command -v opencode >/dev/null && echo "opencode PRESENT" || echo "opencode absent"' )
if grep -q "runtime      codex" "$EVIDENCE/codex-status.txt" \
   && grep -q "codex-cli $CODEX_VERSION" "$EVIDENCE/codex-config.txt" \
   && grep -q '^approval_policy = "never"$' "$EVIDENCE/codex-config.txt" \
   && grep -q '^sandbox_mode = "danger-full-access"$' "$EVIDENCE/codex-config.txt" \
   && grep -q '^wire_api = "responses"$' "$EVIDENCE/codex-config.txt" \
   && grep -q "^opencode absent$" "$EVIDENCE/codex-config.txt"; then
  echo "codex: the default runtime boots, moat renders its config, and its image carries no opencode" | tee -a "$EVIDENCE/extras.txt"
else
  echo "codex: FAILED — the default runtime or its rendered config is not what moat claims" | tee -a "$EVIDENCE/extras.txt"
fi
# The commands that need opencode's server refuse with a pointer rather than a confusing error.
( cd "$CDX" && capture codex-env-refusal $MOAT env )
if grep -q "codex runtime" "$EVIDENCE/codex-env-refusal.txt"; then
  echo "codex: a server command refuses with a pointer instead of failing obscurely" | tee -a "$EVIDENCE/extras.txt"
else
  echo "codex: FAILED — moat env did not explain that the runtime has no server" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$CDX" && $MOAT exec -- sh -c 'echo keep > /work/KEEP.txt; mkdir -p /work/sub && echo deep > /work/sub/DEEP.txt' ) >/dev/null 2>&1
( cd "$CDX" && capture codex-switch $MOAT up --quiet --runtime opencode --no-detect --no-credential )
( cd "$CDX" && capture codex-switch-check $MOAT exec -- sh -c 'cat /work/KEEP.txt /work/sub/DEEP.txt; opencode --version' )
if grep -q "^1.18.31$" "$EVIDENCE/codex-switch-check.txt" \
   && grep -q "^keep$" "$EVIDENCE/codex-switch-check.txt" \
   && grep -q "^deep$" "$EVIDENCE/codex-switch-check.txt"; then
  echo "runtime switch: the other runtime is installed into the live rootfs and /work survives" | tee -a "$EVIDENCE/extras.txt"
else
  echo "runtime switch: FAILED — /work was lost, or the runtime was not installed" | tee -a "$EVIDENCE/extras.txt"
fi
( cd "$CDX" && $MOAT destroy --yes >/dev/null 2>&1 )
echo "" | tee -a "$EVIDENCE/extras.txt"
# After the last write, not before it: this closing line names $EVIDENCE, so
# scrubbing first would leave exactly one unscrubbed path behind.
echo "extras evidence written to $EVIDENCE/extras.txt" | tee -a "$EVIDENCE/extras.txt"
scrub_evidence