#!/usr/bin/env bash
#
# moat verification, part 2: claims that are not in the main acceptance list
# but are made in docs/SPEC.md and the README, so they get the same
# treatment, a command, its real output, and no adjectives.
#
# Covers: rootfs snapshots and restore, `moat apply` (the explicit second step of
# copy-out), credential expiry enforcement, the state-file traps, and the process and
# datapath lifecycle.
#
# Usage: bash test/e2e-extras.sh   (stands on its own: it makes its own fixture and stub)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOAT="node $REPO/cmd/main.ts"
WORK="${MOAT_E2E_DIR:-$HOME/moat-demo}"
PROJECT="$WORK/project"
EVIDENCE="$REPO/test/evidence"
MOCK_PORT="${MOCK_PORT:-5599}"
MOCK_PIDFILE="$WORK/responses-mock.pid"
MOCK_RECORD="$WORK/responses-record.jsonl"
MOCK_SCRIPT="${MOCK_SCRIPT:-$REPO/test/scripts/responses-basic.json}"
CREDENTIAL="moat-e2e-scoped-credential-8c1d4e"

# The failure accumulator, which this suite did not have.
#
# It printed the word FAILED in 46 places and accumulated none of them, and its last
# statement was `scrub_evidence`: the exit status was whatever that `sed` loop
# returned, which is 0. So the suite could report a broken sandbox in its own
# evidence file and still exit 0 -- a check that cannot fail, which
# docs/archive/PROGRAM.md §3 calls out by name. The machinery is in test/lib/guard.sh so
# that e2e-live.sh shares it and so that `bash test/fail-guard.sh` can prove it
# works; every failure must go through `fail`, and `verdict` decides the exit
# status at the very end.
mkdir -p "$EVIDENCE"
CHECKS_LOG="$EVIDENCE/extras.txt"
# Every evidence file this run writes is newer than this; `scrub_evidence` uses it to leave the
# other suites' captures alone.
SUITE_START=$(date +%s)
. "$REPO/test/lib/guard.sh"
check_count

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
  # Only the files *this run* wrote. Globbing `"$EVIDENCE"/*.txt` swept every other suite's evidence
  # too, so running extras rewrote `egress.txt`, `provider.txt`, `demo.txt` and `review.txt` with
  # nothing but a path substitution — found by diffing a PR and asking why four unrelated captures
  # had changed, and worked around by hand in four separate PRs before being fixed here.
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    sed -i -e "s|$HOME|/home/user|g" -e "s|${USER:-$(id -un)}|user|g" "$f"
  done < <(find "$EVIDENCE" -maxdepth 1 -name '*.txt' -newermt "@$SUITE_START" 2>/dev/null)
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

# The keyless model: Codex speaks the Responses wire API, so the stub replays the event shapes
# captured from a real DeepSeek stream. It serves the last scripted turn for any further
# request, so one start covers every section that needs a model.
start_mock() {
  if [ -f "$MOCK_PIDFILE" ]; then kill "$(cat "$MOCK_PIDFILE")" 2>/dev/null; sleep 0.4; fi
  : > "$MOCK_RECORD"
  setsid node "$REPO/stub/mock-responses.mjs" --port "$MOCK_PORT" --script "$MOCK_SCRIPT" \
    --record "$MOCK_RECORD" > "$WORK/responses-mock.log" 2>&1 < /dev/null &
  echo $! > "$MOCK_PIDFILE"
  sleep 1.2
}

: > "$EVIDENCE/extras.txt"
export MOAT_MOCK_CREDENTIAL="$CREDENTIAL"

section "0. fixture: a small node project, and the keyless Responses stub"
# This suite used to run after test/e2e.sh and inherit its fixture and its stub. It stands on
# its own now, which is also what lets it be the acceptance list's second half rather than a
# rider on it.
rm -rf "$PROJECT"; mkdir -p "$PROJECT/src" "$PROJECT/test"
cat > "$PROJECT/package.json" <<'JSON'
{ "name": "extras-fixture", "type": "module", "scripts": { "test": "node --test" } }
JSON
printf 'export const sum = (a, b) => a + b\n' > "$PROJECT/src/sum.js"
cat > "$PROJECT/test/sum.test.js" <<'JS'
import test from "node:test"
import assert from "node:assert/strict"
import { sum } from "../src/sum.js"
test("adds", () => assert.equal(sum(1, 2), 3))
JS
cd "$PROJECT"
git init -q -b main && git config user.email demo@example.com && git config user.name "Demo User"
git add -A && git commit -qm "initial project"
start_mock

section "boot the fixture environment"
capture extras-up $MOAT up --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL

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
capture extras-up-again $MOAT up --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL
capture extras-fetch $MOAT fetch
capture apply-branch $MOAT apply main --name e2e-checkout
# The answer is computed first, outside the pipe: a `pass`/`fail` called inside a
# pipeline runs in a subshell, so the accumulator would never see it. This was the
# one check in the suite that printed `FAIL` by hand, and it was uncounted too.
APPLIED_BRANCH=$(git -C "$PROJECT" branch --list 'e2e-checkout')
{
  echo "\$ git -C $PROJECT branch --list 'e2e-checkout'"
  printf '%s\n' "$APPLIED_BRANCH"
  echo "\$ git -C $PROJECT rev-parse HEAD   # unchanged: apply did not check anything out"
  git -C "$PROJECT" rev-parse HEAD
  echo "\$ git -C $PROJECT status --porcelain   # only the user's own pre-existing dirt"
  git -C "$PROJECT" status --porcelain
} | scrub | tee -a "$EVIDENCE/extras.txt"
if printf '%s' "$APPLIED_BRANCH" | grep -q 'e2e-checkout'; then
  pass "apply --name" "the local branch was created from the fetched ref"
else
  fail "apply --name" "the local branch was not created"
fi

section "E. the injected credential is short-lived, and expiry is enforced"
# The deadline is the credential's own expiry timestamp, not a TTL counted from the entry
# script's start, and the box enforces it itself: it sleeps until the deadline and exits, so a
# sandbox can never outlive its key. Ported to the default runtime before the runtime that used
# to own this behaviour was retired.
echo "booting with --credential-ttl 6s and watching the box stop on its own..." | tee -a "$EVIDENCE/extras.txt"
capture down-for-ttl $MOAT down
capture up-short-ttl $MOAT up --quiet --no-detect --credential-env MOAT_MOCK_CREDENTIAL --credential-ttl 6s
echo "waiting 12s for the deadline to pass..." | tee -a "$EVIDENCE/extras.txt"
sleep 12
capture status-after-ttl $MOAT status
capture logs-ttl $MOAT logs sandbox
# Three separate facts, because "the box stopped" is also what a crash looks like: the box is
# stopped, moat reports the credential as expired, and the entry script names the deadline it
# counted down from the credential's own timestamp (a single-digit remainder, not the default).
if grep -qE "status +stopped" "$EVIDENCE/status-after-ttl.txt" \
   && grep -q "EXPIRED" "$EVIDENCE/status-after-ttl.txt" \
   && grep -qE "expires in [0-9]s; the box stops then" "$EVIDENCE/logs-ttl.txt" \
   && grep -q "expired; stopping the sandbox" "$EVIDENCE/logs-ttl.txt"; then
  pass "credential ttl" "the box stopped itself at the credential deadline, and says so"
else
  fail "credential ttl" "the box outlived its credential"
fi

section "H. the project's own checks, run by moat against the agent's work"
capture verify $MOAT verify
echo "the exit code above is the project's own verdict on whatever is in the sandbox." | tee -a "$EVIDENCE/extras.txt"

section "I. bare moat in a directory with no repository: the work still comes back"
echo "the flow the tool exists for. A plain directory has no repository for git fetch to write" | tee -a "$EVIDENCE/extras.txt"
echo "into, so moat fetch says so and points at moat apply, which merges the sandbox tree through" | tee -a "$EVIDENCE/extras.txt"
echo "the recorded baseline instead. A handful of commands, no session, and --yes where a decision" | tee -a "$EVIDENCE/extras.txt"
echo "would otherwise need a person at a terminal." | tee -a "$EVIDENCE/extras.txt"
PLAIN="$WORK/plain"
rm -rf "$PLAIN"; mkdir -p "$PLAIN"
printf 'a plain directory, no repository\n' > "$PLAIN/README.md"
( cd "$PLAIN" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$PLAIN" && capture plain-up $MOAT up --quiet --no-detect --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
# Work happens inside the box, where a repository does exist; the host directory is untouched.
( cd "$PLAIN" && capture plain-agent $MOAT exec -- sh -c 'cd /work && echo "made inside the box" > agent.txt && git add -A && git -c user.email=a@b -c user.name=a commit -qm "agent: add agent.txt" && git log --oneline -1' )
( cd "$PLAIN" && capture plain-fetch $MOAT fetch )
# `--yes` is what makes this non-interactive, and the first run without it is the control: nothing is
# written to a directory nobody was asked about. This used to apply everything silently, which is
# what `--yes` now means explicitly.
( cd "$PLAIN" && capture plain-apply-no $MOAT apply )
# Read the tree *now*: after the `--yes` below, "the file is not there" is false whatever the first
# apply did, so a condition checked afterwards proves nothing. Measured — that is exactly how the
# first version of this check failed with every other clause true.
PLAIN_UNWRITTEN=no
if [ ! -e "$PLAIN/agent.txt" ]; then PLAIN_UNWRITTEN=yes; fi
( cd "$PLAIN" && capture plain-apply $MOAT apply --yes )
if grep -q "is not a git repository; there is nowhere to fetch into" "$EVIDENCE/plain-fetch.txt" \
   && grep -q "moat apply" "$EVIDENCE/plain-fetch.txt" \
   && grep -q "nothing selected" "$EVIDENCE/plain-apply-no.txt" \
   && [ "$PLAIN_UNWRITTEN" = yes ] \
   && grep -q "agent.txt" "$EVIDENCE/plain-apply.txt" \
   && [ "$(cat "$PLAIN/agent.txt" 2>/dev/null)" = "made inside the box" ]; then
  pass "plain directory copy-out" "a plain directory: fetch refuses and names the way out; apply --yes merges the work, and apply without it writes nothing"
else
  fail "plain directory copy-out" "the work did not come back, or fetch pretended to work, or a bare apply wrote without being asked"
fi
( cd "$PLAIN" && $MOAT destroy --yes >/dev/null 2>&1 )

section "J. first run with no key: it asks, checks, and saves"
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  python3 "$REPO/test/onboard-smoke.py" > "$EVIDENCE/onboard.txt" 2>&1
  ONBOARD_RC=$?
  tail -10 "$EVIDENCE/onboard.txt" | tee -a "$EVIDENCE/extras.txt"
  echo "onboarding exit: $ONBOARD_RC" | tee -a "$EVIDENCE/extras.txt"
else
  echo "skipped: needs DEEPSEEK_API_KEY to prove the accepted path (it refuses a fake key first)" | tee -a "$EVIDENCE/extras.txt"
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
  pass "orphan inventory" "both were listed as orphaned and both were reclaimed"
else
  fail "orphan inventory" "leftover directories: $ORPHANS_LEFT"
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
if grep -q "runtime ready" "$EVIDENCE/logs-sandbox.txt"; then
  pass "boot log" "the banner the box wrote is readable back on the host"
else
  fail "boot log" "no boot banner in the captured output"
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
  pass "bad file name" "refused with the offending bytes, before anything is copied"
else
  fail "bad file name" "no explanation in the output"
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
  pass "log name" "refused instead of reading a host file"
else
  fail "log name" "no refusal in the output"
fi

capture logs-bad-tail $MOAT logs sandbox --tail abc
if grep -q "must be a positive integer" "$EVIDENCE/logs-bad-tail.txt"; then
  pass "--tail" "refused instead of silently printing the whole log"
else
  fail "--tail" "no refusal in the output"
fi

capture models-bogus $MOAT models bogus
# This required the refusal to say "one provider". That was true until `moat models` was made
# provider-aware, and it had been passing on wording since the message changed — the check
# grepped a phrase, not the behaviour. What it is for has not changed: an unknown argument must
# be refused rather than silently listing the default provider and exiting 0. So it asserts the
# refusal and that it names the providers moat does know.
if grep -q "no configured provider" "$EVIDENCE/models-bogus.txt" \
   && grep -q "deepseek" "$EVIDENCE/models-bogus.txt"; then
  pass "models <provider>" "refused, naming the providers it does know, instead of listing the default"
else
  fail "models <provider>" "no refusal in the output"
fi
# The positive half: the default provider still lists its models with its default marked.
capture models-default $MOAT models
if grep -qE "^ \*deepseek-flash" "$EVIDENCE/models-default.txt"; then
  pass "models" "lists the default provider's models and marks the default"
else
  fail "models" "the default provider's listing is not what it was"
fi

capture up-bad-egress $MOAT up --egress bogus
if grep -q "unknown --egress" "$EVIDENCE/up-bad-egress.txt" && ! grep -q "provisioning" "$EVIDENCE/up-bad-egress.txt"; then
  pass "--egress" "refused before provisioning, with the mode named"
else
  fail "--egress" "no refusal before provisioning"
fi

capture up-timeout $MOAT up --timeout 30 --credential-env MOAT_MOCK_CREDENTIAL
if grep -q "sandbox up" "$EVIDENCE/up-timeout.txt"; then
  pass "--timeout" "seconds, not milliseconds, for the boot readiness wait"
else
  fail "--timeout" "a 30-second budget did not cover a warm boot"
fi
capture down-timeout $MOAT down

capture up-bad-ttl $MOAT up --credential-ttl nonsense
if grep -q "invalid duration" "$EVIDENCE/up-bad-ttl.txt" && ! grep -q "copy-in" "$EVIDENCE/up-bad-ttl.txt"; then
  pass "--credential-ttl" "refused before the copy-in, not after it"
else
  fail "--credential-ttl" "the refusal came too late (or not at all)"
fi

# One entry, not three words: --egress-allow is a list, so a value with spaces is three hosts.
capture up-bad-allow $MOAT up --egress-allow "https://internal.example" --egress filtered
if grep -q "URL" "$EVIDENCE/up-bad-allow.txt" && ! grep -q "copy-in" "$EVIDENCE/up-bad-allow.txt"; then
  pass "--egress-allow" "an entry that cannot work is refused before the copy-in"
else
  fail "--egress-allow" "no early refusal"
fi

capture up-empty-model $MOAT up --model ""
if grep -q "needs a model id" "$EVIDENCE/up-empty-model.txt" && ! grep -q "provisioning" "$EVIDENCE/up-empty-model.txt"; then
  pass "--model with an empty value" "refused"
else
  fail "--model with an empty value" "no early refusal"
fi

capture up-empty-base-url $MOAT up --base-url ""
if grep -q "needs a URL" "$EVIDENCE/up-empty-base-url.txt" && ! grep -q "provisioning" "$EVIDENCE/up-empty-base-url.txt"; then
  pass "--base-url with an empty value" "refused"
else
  fail "--base-url with an empty value" "no early refusal"
fi

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
( cd "$STATELESS" && capture stateless-up $MOAT up --quiet --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
STATELESS_ENV=$(cd "$STATELESS" && $MOAT status 2>&1 | sed -n "s/^env *//p")
( cd "$STATELESS" && capture stateless-down $MOAT down )
# The agent's work, made the way the agent makes it: through a real boot of the same rootfs.
( cd "$STATELESS" && capture stateless-work $MOAT exec -- /bin/sh -c "cd /work && printf 'agent work\n' > precious.txt && git add -A && git -c user.email=agent@moat.invalid -c user.name=agent commit -qm 'agent: work the host has never seen' && git rev-parse HEAD" )
STATELESS_HEAD=$(sed -n "s/^\([0-9a-f]\{40\}\)$/\1/p" "$EVIDENCE/stateless-work.out" | tail -1)
rm -f "$STATELESS_ENV/state.json"
( cd "$STATELESS" && capture stateless-recover $MOAT up --quiet --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
if grep -q "recovered from disk" "$EVIDENCE/stateless-recover.err" \
   && grep -q "reusing the sandbox working tree" "$EVIDENCE/stateless-recover.err" \
   && [ -f "$STATELESS_ENV/rootfs/work/precious.txt" ] \
   && [ -n "$STATELESS_HEAD" ]; then
  pass "state recovery" "the rootfs was kept and its working tree reused, not re-copied"
else
  fail "state recovery" "a missing state.json still replaces the environment"
fi
# And the recovered environment is usable: the agent's commit reaches the host.
( cd "$STATELESS" && capture stateless-fetch $MOAT fetch --all )
if git -C "$STATELESS" cat-file -e "$STATELESS_HEAD" 2>/dev/null; then
  pass "state recovery" "the recovered commit fetched to the host (refs/moat/*)"
else
  fail "state recovery" "the recovered commit did not reach the host"
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
( cd "$RACE" && $MOAT up --quiet --no-detect --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL > "$EVIDENCE/race-up.out" 2> "$EVIDENCE/race-up.err" ) &
RACE_UP=$!
RACE_WAIT=0
while [ ! -f "$RACE_MARKER" ] && [ "$RACE_WAIT" -lt 300 ]; do sleep 0.1; RACE_WAIT=$((RACE_WAIT + 1)); done
if [ -f "$RACE_MARKER" ]; then
  pass "boot marker" "the boot marker appeared after ~$((RACE_WAIT / 10))s (state.json written yet: $([ -f "$HOME/.moat/envs/$RACE_ID/state.json" ] && echo yes || echo no))"
else
  fail "boot marker" "no marker appeared within 30s"
fi
( cd "$RACE" && capture race-status $MOAT status )
( cd "$RACE" && capture race-down $MOAT down )
wait "$RACE_UP"; RACE_UP_RC=$?
echo "the background moat up exited $RACE_UP_RC" | tee -a "$EVIDENCE/extras.txt"
if grep -q "booting (pid" "$EVIDENCE/race-status.txt"; then
  pass "status during a boot" "reports booting, not stopped"
else
  fail "status during a boot" "it did not mention the boot"
fi
if grep -q "waiting for it before stopping the sandbox" "$EVIDENCE/race-down.txt" \
   && ! grep -q "is not running" "$EVIDENCE/race-down.txt" \
   && ! grep -q "no moat environment" "$EVIDENCE/race-down.txt"; then
  pass "down during a boot" "waited for the boot and stopped what it produced"
else
  fail "down during a boot" "it acted on the stale state instead of waiting"
fi
RACE_STATE=$( cd "$RACE" && $MOAT status 2>&1 | sed -n "s/^status *//p" )
RACE_PROCS=$(ps -eo cmd | grep -c "[u]nshare --user.*$RACE_ID" || true)
if [ "$RACE_STATE" = "stopped" ] && [ "$RACE_PROCS" = "0" ] && [ ! -f "$RACE_MARKER" ]; then
  pass "after down" "the box is stopped, nothing is left running, and the marker is gone"
else
  fail "after down" "status=$RACE_STATE processes=$RACE_PROCS marker=$([ -f "$RACE_MARKER" ] && echo present || echo gone)"
fi
( cd "$RACE" && $MOAT destroy --yes >/dev/null 2>&1 )
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
( cd "$NOTESTS" && capture notests-up $MOAT up --quiet --no-detect --profile node --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
( cd "$NOTESTS" && capture notests-verify $MOAT verify )
if ! grep -q "checks:" "$EVIDENCE/notests-up.err" \
   && grep -q "no test, lint or typecheck command found" "$EVIDENCE/notests-verify.txt" \
   && grep -q "^--- exit 0$" "$EVIDENCE/notests-verify.txt"; then
  pass "no-tests project" "nothing advertised as a check, and verify says so instead of failing"
else
  fail "no-tests project" "npm's placeholder was still treated as a test suite"
fi
( cd "$NOTESTS" && $MOAT destroy --yes >/dev/null 2>&1 )
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
( cd "$SLOW" && capture slow-up $MOAT up --quiet --no-detect --profile node --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
( cd "$SLOW" && capture slow-verify-default $MOAT verify )
( cd "$SLOW" && capture slow-verify-timeout $MOAT verify --timeout 1 )
SLOW_DUR=$(grep "npm test" "$EVIDENCE/slow-verify-timeout.txt" | grep -oE "[0-9]+\.[0-9]s" | head -1 | tr -d "s")
echo "the check itself was reported at ${SLOW_DUR}s (it sleeps 3; --timeout 1 was asked for)" | tee -a "$EVIDENCE/extras.txt"
if grep -q "^--- exit 0$" "$EVIDENCE/slow-verify-default.txt" \
   && grep -q "^--- exit 1$" "$EVIDENCE/slow-verify-timeout.txt" \
   && grep -q "timed out" "$EVIDENCE/slow-verify-timeout.txt" \
   && awk -v d="${SLOW_DUR:-99}" 'BEGIN{exit !(d < 2.5)}'; then
  pass "--timeout" "a 3-second check is killed at 1s and reported as timed out"
else
  fail "--timeout" "the flag did not shorten the check (reported ${SLOW_DUR}s)"
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
  pass "--timeout on fetch" "refused before any work, not ignored"
else
  fail "--timeout on fetch" "the flag was accepted or the command ran anyway"
fi

capture down-before-z $MOAT down
capture loud-up $MOAT up --no-detect --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL
capture down-mid-z $MOAT down
capture quiet-up $MOAT up --quiet --no-detect --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL
if grep -q "^--- exit 0$" "$EVIDENCE/quiet-up.txt" && ! grep -q "→" "$EVIDENCE/quiet-up.txt"; then
  pass "--quiet" "the boot printed no progress lines, and still succeeded"
else
  fail "--quiet" "progress lines were still printed"
fi
if grep -q "→" "$EVIDENCE/loud-up.txt"; then
  pass "--quiet control" "the control without --quiet printed them, so the check above can fail"
else
  fail "--quiet control" "the control printed no progress lines, so the --quiet check proves nothing"
fi

# --verbose: the flag was read at module load and set inside main() afterwards, so it
# was a no-op and all thirteen log.debug sites were unreachable. The claim is checked
# from outside the process: the same boot, with the flag, has to print a debug line,
# and the boot without it has to not print that line. Both halves in one pair.
capture down-before-verbose $MOAT down
capture verbose-up $MOAT up --verbose --no-detect --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL
DEBUG_LINE="profiles: requested="
if grep -q "$DEBUG_LINE" "$EVIDENCE/verbose-up.txt"; then
  pass "--verbose" "the boot with --verbose printed a debug line"
else
  fail "--verbose" "--verbose printed nothing: the debug line is still unreachable"
fi
if grep -q "$DEBUG_LINE" "$EVIDENCE/loud-up.txt"; then
  fail "--verbose control" "the boot without --verbose printed the debug line too, so the check above proves nothing"
else
  pass "--verbose control" "the boot without --verbose did not print it"
fi
capture down-after-verbose $MOAT down

capture help-flag $MOAT profiles --help
if grep -q "Usage: moat <command>" "$EVIDENCE/help-flag.txt" && ! grep -q "Node.js / TypeScript" "$EVIDENCE/help-flag.txt"; then
  pass "--help" "prints the help text instead of running the command"
else
  fail "--help" "the command ran instead of printing help"
fi
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
( cd "$LEAK" && capture leak-up $MOAT up --quiet --no-detect --model mock-model \
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
# `--yes`: the warning is deliberately *not* a gate, but the write is still a decision, and a
# non-interactive apply now needs to be told to make it (`test/e2e-extras.sh` section I asserts the
# refusal; here the point is that the warning does not stop the write once it is asked for).
( cd "$LEAK" && capture leak-apply $MOAT apply --yes )
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
  pass "copy-out" "          clean commit stays quiet; the file is still applied (a warning, not a gate)"
else
  fail "copy-out" "either the leak was silent, or clean content warned"
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
( cd "$NB" && capture base-url-schemeless $MOAT up --quiet --no-detect --model mock-model \
  --base-url "localhost:$MOCK_PORT/v1" )
# "image provisioned" and "copy-in via" are success lines, so --quiet cannot hide them:
# their absence is what proves the refusal happened before any work was done.
if grep -q "must be an http:// or https:// URL" "$EVIDENCE/base-url-schemeless.txt" \
   && grep -q "did you mean http://localhost:$MOCK_PORT/v1" "$EVIDENCE/base-url-schemeless.txt" \
   && grep -q "^--- exit 1$" "$EVIDENCE/base-url-schemeless.txt" \
   && ! grep -qE "image provisioned|copy-in via" "$EVIDENCE/base-url-schemeless.txt"; then
  pass "base-url" "refused before provisioning, naming the problem and the likely fix"
else
  fail "base-url" "the unusable URL was accepted or the refusal came too late"
fi
# The control: the same host and port with the scheme boots, so the check above cannot
# pass by refusing every --base-url.
( cd "$NB" && capture base-url-schemed $MOAT up --quiet --no-detect --model mock-model \
  --base-url "http://localhost:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
if grep -q "^--- exit 0$" "$EVIDENCE/base-url-schemed.txt" && grep -q "sandbox up" "$EVIDENCE/base-url-schemed.txt"; then
  pass "the control" "the same endpoint with a scheme boots"
else
  fail "the control" "a usable URL was refused"
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
( cd "$BL" && capture branchloss-up $MOAT up --quiet --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
# The agent leaves work on a branch it is not standing on: the case HEAD-only counting missed.
( cd "$BL" && $MOAT exec -- /bin/sh -c 'BASE=$(git -C /work rev-parse --abbrev-ref HEAD); \
  git -C /work checkout -q -b experiment; echo important > /work/experiment.txt; \
  git -C /work add -A; git -C /work -c user.email=a@b -c user.name=agent commit -qm "important work on a side branch"; \
  git -C /work checkout -q "$BASE"' >/dev/null 2>&1 )
( cd "$BL" && $MOAT down >/dev/null 2>&1 )
( cd "$BL" && echo changed-on-the-host >> base.txt )
( cd "$BL" && capture branchloss-up-again $MOAT up --quiet --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
( cd "$BL" && capture branchloss-branches $MOAT exec -- /bin/sh -c \
  'git -C /work branch; echo "--- all commits ---"; git -C /work log --oneline --all | head -4' )
if grep -q "sandbox holds 1 commit(s)" "$EVIDENCE/branchloss-up-again.txt" \
   && grep -q "reusing the sandbox working tree" "$EVIDENCE/branchloss-up-again.txt" \
   && grep -q "experiment" "$EVIDENCE/branchloss-branches.txt" \
   && grep -q "important work on a side branch" "$EVIDENCE/branchloss-branches.txt"; then
  pass "side branch" "a sandbox holding unfetched work is kept, and the warning names it"
else
  fail "side branch" "the re-copy discarded it, or nothing said so"
fi
# The control: once the work *is* on the host (fetched), the same host change re-copies
# automatically — the guard must not block the lossless path it exists for.
( cd "$BL" && $MOAT fetch --all >/dev/null 2>&1 )
( cd "$BL" && $MOAT down >/dev/null 2>&1 )
( cd "$BL" && echo changed-again >> base.txt )
( cd "$BL" && capture branchloss-fetched $MOAT up --quiet --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
if grep -q "holds nothing that is not already on the host" "$EVIDENCE/branchloss-fetched.txt" \
   && grep -q "copy-in via git" "$EVIDENCE/branchloss-fetched.txt"; then
  pass "the control" "fetched work is re-copied over, because the host already has it"
else
  fail "the control" "a lossless re-copy was blocked"
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
( cd "$DET" && capture detached-up $MOAT up --quiet --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
( cd "$DET" && $MOAT exec -- /bin/sh -c 'git -C /work checkout -q --detach HEAD; \
  echo important > /work/detached.txt; git -C /work add -A; \
  git -C /work -c user.email=a@b -c user.name=agent commit -qm "work on a detached HEAD"' >/dev/null 2>&1 )
( cd "$DET" && $MOAT down >/dev/null 2>&1 )
( cd "$DET" && echo changed-on-the-host >> base.txt )
( cd "$DET" && capture detached-up-again $MOAT up --quiet --no-detect --model mock-model \
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
  pass "detached HEAD" "the commit is kept, and the warning names how to fetch it"
else
  fail "detached HEAD" "the commit was discarded, or nothing said so"
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
rm -f "$WORK/af-requests.jsonl"
setsid node "$REPO/stub/mock-responses.mjs" --port "$AF_PORT" --script "$REPO/test/scripts/responses-basic.json" \
  --record "$WORK/af-requests.jsonl" > "$WORK/af-mock.log" 2>&1 < /dev/null &
AF_MOCK=$!
sleep 1.2
NC="$WORK/nocred"
rm -rf "$NC"; mkdir -p "$NC"
( cd "$NC" && git init -q -b main . && printf 'readme\n' > README.md && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base )
( cd "$NC" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$NC" && capture nocred-local $MOAT run --no-credential --no-detect --model mock-model \
  --base-url "http://127.0.0.1:$AF_PORT/v1" "do the task" )
python3 - "$WORK/af-requests.jsonl" > "$WORK/nocred-auth.txt" <<'PYEOF'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1])]
auth = sorted({json.dumps(row.get("authorization")) for row in rows})
print(f"requests this run: {len(rows)}")
print(f"authorization headers: {', '.join(auth) if auth else '(none)'}")
PYEOF
echo "--- what the local endpoint received ---" | tee -a "$EVIDENCE/extras.txt"
cat "$WORK/nocred-auth.txt" | tee -a "$EVIDENCE/extras.txt"
if grep -q "^--- exit 0$" "$EVIDENCE/nocred-local.txt" \
   && grep -q "Fixed src/sum.js" "$EVIDENCE/nocred-local.txt" \
   && grep -q "no credential injected" "$EVIDENCE/nocred-local.txt" \
   && grep -qE "requests this run: [2-9][0-9]*" "$WORK/nocred-auth.txt" \
   && grep -q "authorization headers: null" "$WORK/nocred-auth.txt"; then
  pass "no credential" "the local endpoint runs the task, and no key is sent to it"
else
  fail "no credential" "the endpoint was unreachable, or a credential went with it"
fi
kill "$AF_MOCK" 2>/dev/null; wait "$AF_MOCK" 2>/dev/null
# Control: the native provider cannot work without a key, and still says so before booting.
NATIVE="$WORK/nocred-native"
rm -rf "$NATIVE"; mkdir -p "$NATIVE"
( cd "$NATIVE" && git init -q -b main . && printf 'readme\n' > README.md && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base )
( cd "$NATIVE" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$NATIVE" && capture nocred-native $MOAT run --no-credential --no-detect --model deepseek-flash "do the task" )
if grep -q "no DEEPSEEK_API_KEY, so the agent has no model to call" "$EVIDENCE/nocred-native.txt" \
   && grep -q "^--- exit 1$" "$EVIDENCE/nocred-native.txt" \
   && ! grep -q "sandbox up" "$EVIDENCE/nocred-native.txt"; then
  pass "the control" "the native provider still refuses a task with no key, before booting"
else
  fail "the control" "a keyless native run was attempted"
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
( cd "$KD" && capture killed-up $MOAT up --quiet --no-detect --no-credential --egress isolated \
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
( cd "$KD" && capture killed-up-again $MOAT up --quiet --no-detect --no-credential --egress isolated \
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
  pass "out-of-band kill" "no orphaned datapath survives the next boot, and destroy takes the rest"
else
  fail "out-of-band kill" "old=$OLD_LEFT new=$NEW_UP after-destroy=$AFTER_DESTROY"
fi
# Half two, deterministic: the datapath can exit by itself when the box dies (it notices
# the tap going away), which would leave the reap itself untested. So keep the box alive and
# make its recorded identity stale instead — the state a reboot with pid reuse leaves — and
# the datapath is certainly running when the next boot decides.
( cd "$KD" && capture reaped-up $MOAT up --quiet --no-detect --no-credential --egress isolated \
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
( cd "$KD" && capture reaped-up-again $MOAT up --quiet --no-detect --no-credential --egress isolated \
  --model mock-model --base-url "http://127.0.0.1:$MOCK_PORT/v1" )
REAPED_LEFT=$(count_datapath "$LIVE_BOX")
if grep -q "reaped the datapath of a sandbox that is no longer running (pid $LIVE_SLIRP)" "$EVIDENCE/reaped-up-again.txt" \
   && [ "$REAPED_LEFT" = "0" ]; then
  pass "stale identity" "the datapath of a box that is not ours is reaped, and named"
else
  fail "stale identity" "datapath left=$REAPED_LEFT"
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
( cd "$REAP_ENV" && capture reap-down-up $MOAT up --quiet --no-detect --no-credential --egress isolated \
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
  pass "down" "a datapath the recorded box cannot be signalled for is reaped, named, then forgotten"
else
  fail "down" "datapath left=$DOWN_LEFT recorded=$DOWN_RECORD"
fi
kill -9 -- "-$DBOX" 2>/dev/null
( cd "$REAP_ENV" && $MOAT destroy --yes >/dev/null 2>&1 )

# Half four: `destroy` deletes the environment, so the record goes with the directory.
( cd "$REAP_ENV" && capture reap-destroy-up $MOAT up --quiet --no-detect --no-credential --egress isolated \
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
  pass "destroy" "the environment is removed and its datapath with it"
else
  fail "destroy" "datapath left=$DEST_LEFT envdir=$([ -e "$DENVDIR" ] && echo present || echo gone)"
fi
kill -9 -- "-$XBOX" 2>/dev/null

# Half five: `restore` clears the datapath fields for a box it will not signal.
( cd "$REAP_ENV" && capture reap-restore-up $MOAT up --quiet --no-detect --no-credential --egress isolated \
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
  pass "restore" "the datapath is reaped before the record that names it is cleared"
else
  fail "restore" "datapath left=$REST_LEFT"
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
( cd "$NL" && capture nocred-doctor-up $MOAT up --quiet --no-detect --no-credential --egress isolated --model deepseek-flash )
( cd "$NL" && capture nocred-doctor $MOAT doctor )
if grep -q "no variable from the host environment reached the sandbox" "$EVIDENCE/nocred-doctor.txt" \
   && ! grep -E "reached the sandbox.*DEEPSEEK_API_KEY" "$EVIDENCE/nocred-doctor.txt" \
   && ! grep -q "which is the credential" "$EVIDENCE/nocred-doctor.txt" \
   && grep -q "no secret-looking variable reaches tool execution" "$EVIDENCE/nocred-doctor.txt" \
   && ! grep -q "spend-capped" "$EVIDENCE/nocred-doctor.txt"; then
  pass "no-credential box" "the doctor reports no key in the box, and does not invent one"
else
  fail "no-credential box" "the doctor's report does not match the box"
fi
( cd "$NL" && $MOAT destroy --yes >/dev/null 2>&1 )
# The control: a box that does have a credential keeps the exposure, names which variable is
# the credential, and does not claim the native provider's variable for a custom endpoint.
CL="$WORK/cred-doctor"
rm -rf "$CL"; mkdir -p "$CL"
( cd "$CL" && git init -q -b main . && printf 'x\n' > a.txt && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base )
( cd "$CL" && $MOAT destroy --yes >/dev/null 2>&1 )
( cd "$CL" && capture cred-doctor-up $MOAT up --quiet --no-detect --egress isolated --model mock-model \
  --base-url "http://127.0.0.1:$MOCK_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
( cd "$CL" && capture cred-doctor $MOAT doctor )
grep "are in the environment tool execution inherits" "$EVIDENCE/cred-doctor.txt" > "$WORK/cred-doctor-detail.txt" || true
if grep -qE "of which .*MOAT_INJECTED_CREDENTIAL.*is the credential" "$EVIDENCE/cred-doctor.txt" \
   && grep -q "spend-capped token" "$WORK/cred-doctor-detail.txt" \
   && ! grep -E "reached the sandbox.*DEEPSEEK_API_KEY" "$EVIDENCE/cred-doctor.txt" \
   && ! grep -q "DEEPSEEK_API_KEY" "$WORK/cred-doctor-detail.txt"; then
  pass "the control" "a box with a credential still reports it, and names which variable it is"
else
  fail "the control" "a credentialed box's exposure was lost or misnamed"
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
( cd "$ESC_PROJECT" && capture escape-up $MOAT up --quiet --no-credential --egress isolated --profile node --model deepseek-flash )
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
  pass "check output" "escapes are dropped, and the text around them still reaches the user"
else
  fail "check output" "an escape byte reached the terminal, or the output was dropped"
fi
( cd "$ESC_PROJECT" && $MOAT destroy --yes >/dev/null 2>&1 )
section "AJ. the runtime boots, and a deleted runtime binary is repaired without touching /work"
# Codex ships a musl binary in its npm platform tarball, so it runs on the Alpine image with no
# gcompat and no Node runtime. The agent is root inside its own rootfs, so it can delete that
# binary; the next boot has to put it back by copying into the live rootfs, because
# re-provisioning deletes the rootfs first and takes /work with it (measured: an untracked file
# was lost that way before the installer was written).
CDX="$WORK/codex-runtime"
rm -rf "$CDX"; mkdir -p "$CDX"
( cd "$CDX" && git init -q -b main . && printf 'x\n' > a.txt && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base )
( cd "$CDX" && $MOAT destroy --yes >/dev/null 2>&1 )
CODEX_VERSION=$(node -e "import('$REPO/lib/pins.ts').then((m) => console.log(m.CODEX_VERSION))")
( cd "$CDX" && capture codex-up $MOAT up --quiet --no-detect --no-credential )
( cd "$CDX" && capture codex-status $MOAT status )
( cd "$CDX" && capture codex-config $MOAT exec -- sh -c 'codex --version; cat /root/.codex/config.toml; head -1 /root/.codex/AGENTS.md; command -v opencode >/dev/null && echo "opencode PRESENT" || echo "opencode absent"' )
if grep -q "codex        0.155.1 / alpine" "$EVIDENCE/codex-status.txt" \
   && grep -q "codex-cli $CODEX_VERSION" "$EVIDENCE/codex-config.txt" \
   && grep -q '^approval_policy = "never"$' "$EVIDENCE/codex-config.txt" \
   && grep -q '^sandbox_mode = "danger-full-access"$' "$EVIDENCE/codex-config.txt" \
   && grep -q '^wire_api = "responses"$' "$EVIDENCE/codex-config.txt" \
   && grep -q "^opencode absent$" "$EVIDENCE/codex-config.txt"; then
  pass "codex" "the default runtime boots, moat renders its config and its brief, and no opencode is in the image"
else
  fail "codex" "the default runtime or its rendered config is not what moat claims"
fi
( cd "$CDX" && capture codex-rm $MOAT exec -- sh -c 'rm -f /usr/local/bin/codex; command -v codex || echo "codex gone"; echo keep > /work/KEEP.txt; mkdir -p /work/sub && echo deep > /work/sub/DEEP.txt' )
( cd "$CDX" && capture codex-down $MOAT down )
# No --quiet here: the install step is a progress line, and this check reads it.
( cd "$CDX" && capture codex-repair $MOAT up --no-detect --no-credential )
( cd "$CDX" && capture codex-repair-check $MOAT exec -- sh -c 'codex --version; cat /work/KEEP.txt /work/sub/DEEP.txt' )
if grep -q "codex-cli $CODEX_VERSION" "$EVIDENCE/codex-repair-check.txt" \
   && grep -q "^keep$" "$EVIDENCE/codex-repair-check.txt" \
   && grep -q "^deep$" "$EVIDENCE/codex-repair-check.txt" \
   && grep -q "installing the codex runtime into this environment" "$EVIDENCE/codex-repair.txt"; then
  pass "runtime repair" "a deleted runtime binary: reinstalled into the live rootfs on the next boot, and /work survived"
else
  fail "runtime repair" "the binary was not reinstalled, or /work was lost"
fi
( cd "$CDX" && $MOAT destroy --yes >/dev/null 2>&1 )
section "AK. the codex runtime drives a keyless model stub end to end"
# Codex speaks the Responses wire API, so the chat-completions stub that drives opencode
# cannot drive it. stub/mock-responses.mjs replays the event shapes captured from a real
# DeepSeek stream through a recording proxy, which makes the DEFAULT runtime testable
# without a key — including the project's own checks, which are the verdict the user reads.
CK="$WORK/codex-mock"
rm -rf "$CK"; mkdir -p "$CK/src" "$CK/test"
cat > "$CK/package.json" <<'JSON'
{ "name": "ak-fix", "type": "module", "scripts": { "test": "node --test" } }
JSON
cat > "$CK/src/sum.js" <<'JS'
export const sum = (a, b) => a - b
JS
cat > "$CK/test/sum.test.js" <<'JS'
import test from "node:test"
import assert from "node:assert/strict"
import { sum } from "../src/sum.js"
test("adds", () => assert.equal(sum(1, 2), 3))
JS
( cd "$CK" && git init -q -b main . && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base )
( cd "$CK" && $MOAT destroy --yes >/dev/null 2>&1 )
RESP_PORT=5597
rm -f "$WORK/responses-requests.jsonl"
node "$REPO/stub/mock-responses.mjs" --port "$RESP_PORT" --script "$REPO/test/scripts/responses-basic.json" \
  --record "$WORK/responses-requests.jsonl" > "$WORK/mock-responses.log" 2>&1 &
RESP_PID=$!
sleep 1
export MOAT_MOCK_CREDENTIAL="moat-e2e-responses-stub"
# deepseek-flash, not mock-model: it is the model the vendored catalog describes, which is what
# removes Codex's fallback-metadata notice and gives --effort something to move. The endpoint is
# still the stub; only the id changes, and the stub ignores it.
( cd "$CK" && capture codex-mock-up $MOAT up --quiet --profile node --model deepseek-flash --effort high \
  --base-url "http://127.0.0.1:$RESP_PORT/v1" --credential-env MOAT_MOCK_CREDENTIAL )
( cd "$CK" && capture codex-mock-run $MOAT run --effort high --credential-env MOAT_MOCK_CREDENTIAL "Make the failing test pass." )
( cd "$CK" && capture codex-mock-fix $MOAT exec -- sh -c 'cat /work/src/sum.js; git -C /work log --oneline -1' )
# The project's own checks are the verdict the user reads, and they run inside the box with
# no model involved. This is the half that says the runtime swap did not cost moat its loop.
( cd "$CK" && capture codex-mock-verify $MOAT verify )
( cd "$CK" && capture codex-mock-fetch $MOAT fetch )
# moat's brief has to reach the model under this runtime, and Codex reads it from its own
# home: measured through the recording proxy, the content arrives in the request body wrapped
# as AGENTS.md instructions. Both halves are checked — the file in the box, and the text the
# provider actually received.
# The marker is a line every rendered brief carries, whatever the egress mode and credential
# state: asserting on a conditional sentence is how this check first reported a false negative.
( cd "$CK" && capture codex-mock-brief $MOAT exec -- sh -c 'grep -m1 "disposable Linux container" /root/.codex/AGENTS.md' )
kill "$RESP_PID" 2>/dev/null
# The other half of --effort: a second boot of the same environment, same stub, same model, only
# the level changed. The record is a separate file so the two turns cannot be confused, and the
# endpoint is passed again because state records the previous one. What is asserted is the
# REQUEST the provider received, not the config moat says it wrote — a later boot of this
# environment (exec, verify) re-renders config.toml from that boot's flags, with no effort in it.
RESP_PORT_LOW=5598
rm -f "$WORK/responses-requests-low.jsonl"
node "$REPO/stub/mock-responses.mjs" --port "$RESP_PORT_LOW" --script "$REPO/test/scripts/responses-basic.json" \
  --record "$WORK/responses-requests-low.jsonl" > "$WORK/mock-responses-low.log" 2>&1 &
RESP_PID_LOW=$!
sleep 1
( cd "$CK" && capture codex-mock-run-low $MOAT run --effort low --model deepseek-flash --credential-env MOAT_MOCK_CREDENTIAL \
  --base-url "http://127.0.0.1:$RESP_PORT_LOW/v1" "Make the failing test pass." )
kill "$RESP_PID_LOW" 2>/dev/null
PINNED_SHA=$( cd "$REPO" && node -e 'import("./bundle/codex.ts").then(m => console.log(m.CATALOG_INSTRUCTIONS_SHA256))' )
BRIEF_IN_REQUEST=$(python3 - "$WORK/responses-requests.jsonl" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
print("yes" if any("disposable Linux container" in (r.get("body") or "") for r in rows) else "no")
PY
)
REQS=$(wc -l < "$WORK/responses-requests.jsonl" 2>/dev/null || echo 0)
# The catalog's three claims, read from what the provider received (and from the CLI's own output
# for the notice, which never reaches the wire). The pre-catalog control was measured on this
# fixture: the notice was present, the advertised tools included web_search, and the wire carried
# no reasoning.effort for either level. Each of these can therefore fail.
EFFORT_OK=0
python3 - "$WORK/responses-requests.jsonl" "$WORK/responses-requests-low.jsonl" "$PINNED_SHA" <<'PY' | tee -a "$EVIDENCE/extras.txt" || EFFORT_OK=1
import hashlib, json, sys
pinned = sys.argv[3]
def rows(path):
    return [json.loads(l) for l in open(path)]
high, low = rows(sys.argv[1]), rows(sys.argv[2])
def efforts(rs):
    return sorted({(r.get("reasoning") or {}).get("effort") for r in rs if r.get("reasoning")})
tools = sorted({t for r in high + low for t in (r.get("tools") or [])})
shas = sorted({hashlib.sha256((r.get("instructions") or "").encode()).hexdigest() for r in high + low})
print("effort high record : requests", len(high), "reasoning", efforts(high))
print("effort low record  : requests", len(low), "reasoning", efforts(low))
print("tools advertised   :", tools)
print("instructions sha256:", shas)
ok = (
    efforts(high) == ["high"]
    and efforts(low) == ["low"]
    and "web_search" not in tools
    and shas == [pinned]
)
sys.exit(0 if ok else 1)
PY
if grep -q "a + b" "$EVIDENCE/codex-mock-fix.txt" \
   && grep -q "fix: sum adds" "$EVIDENCE/codex-mock-fix.txt" \
   && grep -qE "pass +npm test" "$EVIDENCE/codex-mock-verify.txt" \
   && ! grep -qE "FAIL +npm test" "$EVIDENCE/codex-mock-verify.txt" \
   && grep -q "fetched .*refs/moat/" "$EVIDENCE/codex-mock-fetch.txt" \
   && grep -q "src/sum.js" "$EVIDENCE/codex-mock-run.txt" \
   && grep -q "disposable Linux container" "$EVIDENCE/codex-mock-brief.out" \
   && [ "$BRIEF_IN_REQUEST" = "yes" ] \
   && [ "$REQS" -ge 2 ] \
   && [ "$EFFORT_OK" = "0" ] \
   && ! grep -q "Model metadata for" "$EVIDENCE/codex-mock-run.txt" \
   && ! grep -q "Model metadata for" "$EVIDENCE/codex-mock-run-low.txt"; then
  echo "codex: a keyless turn fixes the fixture, the checks pass, the commit fetches, and moat's brief reached the model ($REQS model requests)" | tee -a "$EVIDENCE/extras.txt"
  pass "codex" "the catalog removed the metadata notice, disabled web_search, and --effort high/low reached the wire as asked (see the record lines above)"
else
  fail "codex" "no fix, or the brief did not reach the model (requests=$REQS, brief_in_request=$BRIEF_IN_REQUEST, effort_ok=$EFFORT_OK)"
fi
( cd "$CK" && $MOAT destroy --yes >/dev/null 2>&1 )

section "AL. the default runtime opens a live TUI"
# The interactive surface of the codex runtime is Codex's own TUI on a pty inside the box.
# This allocates a real pty, runs moat with no arguments, and requires that the TUI was
# reached (not the help text), drew a screen and stayed up, and that leaving it left the
# sandbox running. Keyless: no model call is needed to answer any of that.
echo "the default runtime's interactive surface, driven through a real pty" | tee -a "$EVIDENCE/extras.txt"
python3 "$REPO/test/codex-tui.py" 2>&1 | scrub > "$EVIDENCE/codex-tui.txt"
TUI_RC=$?
tail -6 "$EVIDENCE/codex-tui.txt" | tee -a "$EVIDENCE/extras.txt"
if [ "$TUI_RC" = "0" ] && grep -q "codex tui: the default runtime opens a live TUI" "$EVIDENCE/codex-tui.txt"; then
  pass "codex tui" "moat reaches a live TUI, and leaving it leaves the sandbox running"
else
  fail "codex tui" "moat did not reach a live TUI (exit $TUI_RC)"
fi
( cd "$WORK/codex-tui" && $MOAT destroy --yes >/dev/null 2>&1 )

section "AM. a partial accept that breaks the project's check is refused, not written"
# The one failure the review exists to prevent, and the one it used to admit to: take the change
# to one file and reject the change to the file that makes it compile. SPEC §4.1 listed that as a
# limitation. The check is the project's own, run against exactly the accepted subset, and the
# host tree is not touched to run it.
AM="$WORK/coherence"
rm -rf "$AM"; mkdir -p "$AM"
(
  cd "$AM"
  git init -q -b main .
  git config user.email a@b
  git config user.name t
  printf '{"name":"coherence","scripts":{"test":"sh test.sh"}}\n' > package.json
  printf '1\n' > config.txt
  printf '#!/bin/sh\ngrep -q "^1$" config.txt\n' > test.sh
  git add -A && git commit -qm base
)
( cd "$AM" && $MOAT up --quiet --no-credential --no-detect --profile node --egress isolated --model deepseek-flash ) > "$WORK/coh-up.log" 2>&1
# The agent changes both files together: the config to 2, and the check that asserts 2.
cat > "$WORK/coh-agent.sh" <<'BOX'
cd /work
printf '2\n' > config.txt
cat > test.sh <<'INNER'
#!/bin/sh
grep -q "^2$" config.txt
INNER
git add -A
git -c user.email=a@b -c user.name=a commit -qm agent
BOX
( cd "$AM" && $MOAT exec -- sh -c "$(cat "$WORK/coh-agent.sh")" ) > "$WORK/coh-agent.log" 2>&1

# The incoherent subset: the config change only, so the check (now expecting 2) runs against a tree
# that still holds 1. Nothing may be written.
( cd "$AM" && $MOAT apply --only config.txt ) > "$WORK/coh-partial.out" 2>&1
COH_PARTIAL=$?
COH_LEFT=$(cat "$AM/config.txt")

# The control, so the check above cannot pass on a broken apply: --no-verify writes the same subset
# through, which is what shows it was the *verify* that stopped it and not something else.
( cd "$AM" && $MOAT apply --only config.txt --no-verify ) > "$WORK/coh-forced.out" 2>&1
COH_FORCED=$?
COH_FORCED_VAL=$(cat "$AM/config.txt")

{
  echo "--- \$ moat apply --only config.txt             (the subset whose check fails)"
  cat "$WORK/coh-partial.out"
  echo "--- exit $COH_PARTIAL   config.txt after = $COH_LEFT"
  echo ""
  echo "--- \$ moat apply --only config.txt --no-verify  (the same subset, verification off)"
  cat "$WORK/coh-forced.out"
  echo "--- exit $COH_FORCED   config.txt after = $COH_FORCED_VAL"
} | scrub | tee -a "$EVIDENCE/extras.txt" > "$EVIDENCE/coherence.txt"

if [ "$COH_PARTIAL" != "0" ] \
   && grep -q "does not pass the project's own checks" "$WORK/coh-partial.out" \
   && [ "$COH_LEFT" = "1" ] \
   && [ "$COH_FORCED" = "0" ] \
   && grep -q "applied 1 change" "$WORK/coh-forced.out" \
   && [ "$COH_FORCED_VAL" = "2" ]; then
  pass "coherence" "an accepted subset that fails the project's own check is refused with nothing written, and --no-verify still writes it"
else
  fail "coherence" "expected a refusal (exit=$COH_PARTIAL, left=$COH_LEFT) and a forced write (exit=$COH_FORCED, wrote=$COH_FORCED_VAL)"
fi
( cd "$AM" && $MOAT destroy --yes >/dev/null 2>&1 )

section "AN. the second runtime runs a turn end to end, keyless"
# Phase 2's payoff: `moat run` under `--runtime claude`, against the keyless Messages stub. The
# assertions are on the *provider's* view (what the stub recorded) and on what the agent's own
# stream says happened, rather than on moat's account of either.
AN="$WORK/claude-runtime"
AN_PORT="${AN_PORT:-5612}"
rm -rf "$AN"; mkdir -p "$AN"
(
  cd "$AN"
  git init -q -b main .
  git config user.email a@b
  git config user.name t
  printf '{"name":"claude-runtime","scripts":{"test":"true"}}\n' > package.json
  git add -A && git commit -qm base
)
: > "$WORK/anthropic-record.jsonl"
setsid node "$REPO/stub/mock-anthropic.mjs" --port "$AN_PORT" --record "$WORK/anthropic-record.jsonl" \
  --command "sh -c 'echo ci-changed > notes.txt && echo stub-tool-ran && git add -A && git -c user.email=a@b -c user.name=a commit -qm ci'" \
  > "$WORK/anthropic-stub.log" 2>&1 < /dev/null &
AN_STUB=$!
sleep 1.2
# The provider is on the host's loopback, so the box gets the host's network namespace — the same
# reason moat chooses `open` for a loopback endpoint by itself.
( cd "$AN" && $MOAT up --quiet --runtime claude --credential "$CREDENTIAL" \
    --base-url "http://127.0.0.1:$AN_PORT" --model claude-opus-5 --no-detect --profile node --egress open ) > "$WORK/claude-up.log" 2>&1
AN_UP=$?
# Every boot re-mints the credential from the host — state.json keeps a fingerprint and never the
# value — so the runs need the source too, not only the `up` above. They used to omit it, and the
# section passed only where the host happened to carry a key of its own (`DEEPSEEK_API_KEY`, or
# `~/.moat/credentials.json`): measured, the committed capture records fingerprint
# `sha256:34c4e933b47c1fb3` while this section's own value is `sha256:7726b438889c7f57`, so what the
# run injected was never the credential this test passes in. On a host with no ambient key the box
# logs `Not logged in · Please run /login`, nothing reaches the stub, and the section fails. Codex
# tolerates a keyless custom endpoint, which is why the acceptance suite never noticed the shape;
# Claude Code does not.
#
# `--credential` and not `--credential-env`: this script re-points `MOAT_MOCK_CREDENTIAL` at the
# Responses stub further up, so naming the value here keeps the section's credential its own
# instead of silently inheriting whatever that export happens to hold.
( cd "$AN" && $MOAT run "run the check" --quiet --credential "$CREDENTIAL" ) > "$WORK/claude-run.log" 2>&1
AN_RUN=$?
# And a ceiling stops one mid-turn: the stub reports 160 tokens on its first request, so a limit of
# 100 has to kill the box before the second request is paid for. The control above (no ceiling) is
# what makes this a measurement rather than a claim.
( cd "$AN" && $MOAT run "run the check" --quiet --max-tokens 100 --credential "$CREDENTIAL" ) > "$WORK/claude-ceiling.log" 2>&1
AN_CEIL=$?
# The machine-readable review: `moat take` fetches the agent's branch, classifies the three trees
# and runs the project's own checks, and `--json` is the same decision in a shape a pipeline reads.
( cd "$AN" && $MOAT take --json < /dev/null ) > "$WORK/claude-review.json" 2> "$WORK/claude-take.log"
AN_TAKE=$?
AN_JSON=$(python3 -c "
import json
d=json.load(open('$WORK/claude-review.json'))
paths=[r['path'] for r in (d.get('reviewed') or [])]
checks=d.get('checks') or {}
print('yes' if d.get('treeUntouched') is True and 'notes.txt' in paths and checks.get('ok') is True else 'no')
" 2>/dev/null || echo no)
AN_REQS=$(grep -c '/v1/messages' "$WORK/anthropic-record.jsonl" 2>/dev/null || echo 0)
# The credential has to reach the runtime under the name *it* reads, not moat's: Claude Code reads
# ANTHROPIC_API_KEY, and the stub records the header the provider actually received.
AN_KEY=$(python3 -c "
import json
ok='no'
for line in open('$WORK/anthropic-record.jsonl'):
    d=json.loads(line)
    if str(d.get('path','')).startswith('/v1/messages') and d.get('apiKey'):
        ok='yes'
print(ok)
" 2>/dev/null || echo no)
kill $AN_STUB 2>/dev/null
{
  echo "--- \$ moat up --runtime claude   (a second runtime, provisioned and booted)"
  grep -E "runtime|prov" "$WORK/claude-up.log" | head -4
  echo "--- \$ moat run \"run the check\"   (a turn through the Claude runtime)"
  cat "$WORK/claude-run.log"
  echo "--- \$ moat run \"run the check\" --max-tokens 100   (a ceiling, mid-turn)"
  tail -4 "$WORK/claude-ceiling.log"
  echo "--- \$ moat take --json   (the review, machine-readable)"
  echo "treeUntouched + notes.txt in the classification + checks ok: $AN_JSON"
  python3 -c "
import json
d=json.load(open('$WORK/claude-review.json'))
print('  branch:', d.get('branch'), '| commits:', d.get('commits'), '| treeUntouched:', d.get('treeUntouched'))
for r in (d.get('reviewed') or []): print(f\"  {r['verdict']:8} {r['path']} ({r['kind']})\")
print('  checks:', (d.get('checks') or {}).get('summary'))
" 2>/dev/null
  echo "--- the provider's own record ---"
  echo "requests to /v1/messages: $AN_REQS    credential reached the runtime: $AN_KEY"
} | scrub | tee -a "$EVIDENCE/extras.txt" > "$EVIDENCE/claude-runtime.txt"

if [ "$AN_UP" = "0" ] \
   && [ "$AN_RUN" = "0" ] \
   && grep -q "stub-tool-ran" "$WORK/claude-run.log" \
   && [ "$AN_REQS" -ge 2 ] \
   && [ "$AN_KEY" = "yes" ] \
   && [ "$AN_CEIL" = "1" ] \
   && grep -q "reached its token ceiling" "$WORK/claude-ceiling.log" \
   && grep -qi "sandbox was killed" "$WORK/claude-ceiling.log" \
   && [ "$AN_TAKE" = "0" ] \
   && [ "$AN_JSON" = "yes" ]; then
  pass "claude runtime" "a turn ran, a ceiling killed one mid-turn, and take --json reported the review machine-readably"
else
  fail "claude runtime" "up=$AN_UP run=$AN_RUN reqs=$AN_REQS key=$AN_KEY ceiling=$AN_CEIL take=$AN_TAKE json=$AN_JSON"
fi
( cd "$AN" && $MOAT destroy --yes >/dev/null 2>&1 )
section "AO. the container backend runs a turn, on a host that has a container runtime"
# The second backend, end to end. It needs a container runtime the CI runner does not have, so the
# section *skips with a reason* rather than pretending — the same shape as the sandbox suites that
# cannot run on GitHub's runners. What is asserted is the lifecycle: a boot, a check inside it, and
# that `down` leaves nothing behind. That last one is the defect this section exists for: killing
# the `podman run` client left the container running while state.json said stopped.
AO="$WORK/container-backend"
rm -rf "$AO"; mkdir -p "$AO"
(
  cd "$AO"
  git init -q -b main .
  git config user.email a@b
  git config user.name t
  printf '{"name":"container-backend","scripts":{"test":"test -f package.json"}}\n' > package.json
  git add -A && git commit -qm base
)
if ! command -v podman >/dev/null 2>&1 || ! podman info >/dev/null 2>&1; then
  {
    echo "  SKIPPED  no usable container runtime on this host"
    echo "  the backend is exercised by test/unit/backend.test.ts everywhere, and end to end"
    echo "  wherever a runtime exists; docs/PORTABILITY.md §3 has the readings taken on one."
  } | scrub | tee -a "$EVIDENCE/extras.txt" > "$EVIDENCE/container-backend.txt"
  pass "container backend" "no container runtime here, so the end-to-end half is skipped"
else
  # The DEFAULT egress (filtered), deliberately: `--egress isolated` skips the ruleset, and the
  # first version of this section used it — so the section passed while the default path failed at
  # boot with "netlink: Error: cache initialization failed: Operation not permitted".
  ( cd "$AO" && $MOAT up --backend container --quiet --no-credential --no-detect --profile node --model deepseek-flash ) > "$AO/up.log" 2>&1
  AO_UP=$?
  ( cd "$AO" && $MOAT exec -- sh -c 'id -u; ls -d /home/ektor 2>/dev/null || echo no-host-home' ) > "$AO/exec.log" 2>&1
  AO_EXEC=$?
  ( cd "$AO" && $MOAT verify --quiet ) > "$AO/verify.log" 2>&1
  AO_VERIFY=$?
  # The ruleset has to be *inside* the box: filtering without applying it is the silent failure.
  ( cd "$AO" && $MOAT exec -- sh -c 'nft list ruleset 2>/dev/null | grep -c "policy drop"' ) > "$AO/ruleset.log" 2>&1
  AO_RULESET=$(grep -o "1" "$AO/ruleset.log" | head -1 || echo 0)
  AO_CONTAINERS_WHILE=$(podman ps --format '{{.ID}}' 2>/dev/null | wc -l)
  ( cd "$AO" && $MOAT down ) > "$AO/down.log" 2>&1
  AO_DOWN=$?
  sleep 2
  AO_CONTAINERS_AFTER=$(podman ps -a --format '{{.ID}}' 2>/dev/null | wc -l)
  {
    echo "--- \$ moat up --backend container   (default egress: filtered)"
    tail -3 "$AO/up.log"
    echo "--- \$ moat exec -- sh -c 'id -u; ls -d \$HOME'"
    tail -3 "$AO/exec.log"
    echo "--- \$ moat verify"
    grep -E "pass|FAIL" "$AO/verify.log" | tail -2
    echo "--- \$ moat down"
    tail -2 "$AO/down.log"
    echo "--- \$ moat exec -- nft list ruleset | grep -c 'policy drop'   (is the allowlist really applied?)"
    echo "    $AO_RULESET"
    echo "--- containers: while up = $AO_CONTAINERS_WHILE, after down = $AO_CONTAINERS_AFTER"
  } | scrub | tee -a "$EVIDENCE/extras.txt" > "$EVIDENCE/container-backend.txt"

  if [ "$AO_UP" = "0" ] \
     && [ "$AO_EXEC" = "0" ] \
     && grep -q "^0$" "$AO/exec.log" \
     && grep -q "no-host-home" "$AO/exec.log" \
     && [ "$AO_VERIFY" = "0" ] \
     && [ "$AO_RULESET" = "1" ] \
     && [ "$AO_CONTAINERS_WHILE" -ge 1 ] \
     && [ "$AO_CONTAINERS_AFTER" = "0" ]; then
    pass "container backend" "a box booted in a container with the DEFAULT filtered egress, applied moat's ruleset inside, ran the project's check as uid 0 with no host home, and left no container behind"
  else
    fail "container backend" "up=$AO_UP exec=$AO_EXEC verify=$AO_VERIFY ruleset=$AO_RULESET while=$AO_CONTAINERS_WHILE after=$AO_CONTAINERS_AFTER"
  fi
  ( cd "$AO" && $MOAT destroy --yes >/dev/null 2>&1 )
fi
# The stub belongs to this suite: e2e.sh used to start it and extras used to inherit it.
if [ -f "$MOCK_PIDFILE" ]; then kill "$(cat "$MOCK_PIDFILE")" 2>/dev/null; rm -f "$MOCK_PIDFILE"; fi
echo "" | tee -a "$EVIDENCE/extras.txt"
# After the last write, not before it: this closing line names $EVIDENCE, so
# scrubbing first would leave exactly one unscrubbed path behind.
echo "extras evidence written to $EVIDENCE/extras.txt" | tee -a "$EVIDENCE/extras.txt"
scrub_evidence
# The verdict is last so that it lands in the scrubbed evidence too, and so that
# the exit status is the count of failed checks rather than whatever `sed`
# returned. `verdict` prints the summary; this is what makes the suite fail.
verdict
exit $?