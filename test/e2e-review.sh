#!/usr/bin/env bash
#
# Phase 3's gate: a real repo with real agent work, a partial accept, and the host tree containing
# exactly what the user approved and nothing else.
#
# The unit tests hold every classification branch and every partial-accept path. This is the
# end-to-end half: the whole boot, a real sandbox, real agent commits, `moat apply --dry-run`
# reviewed by a script, and one hunk taken out of two.
#
# What it asserts about the tree is byte-level and after the fact: the file contains the accepted
# hunk's line, does not contain the rejected hunk's line, and is otherwise identical to what it
# was. A partial accept that wrote the whole file, or that wrote nothing, fails here.
#
# Usage: bash test/e2e-review.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
M="node $REPO/cmd/main.ts"
EVIDENCE="$REPO/test/evidence"
LOG="$EVIDENCE/review.txt"
WORK="${MOAT_E2E_DIR:-$HOME/moat-demo}/review-gate"
PROJECT="$WORK/project"

mkdir -p "$EVIDENCE" "$WORK"
: > "$LOG"
CHECKS_LOG="$LOG"
. "$REPO/test/lib/guard.sh"
check_count

say() { echo "$@" | tee -a "$LOG"; }
scrub() { sed -e "s|$HOME|/home/user|g" -e "s|${USER:-$(id -un)}|user|g"; }

export MOAT_HOME="$WORK/home"
unset DEEPSEEK_API_KEY MOAT_CREDENTIAL 2>/dev/null || true

cleanup_review() {
  [ -d "$PROJECT" ] && ( cd "$PROJECT" && MOAT_HOME="$MOAT_HOME" node "$REPO/cmd/main.ts" destroy --yes >/dev/null 2>&1 )
  return 0
}
trap cleanup_review EXIT

rm -rf "$WORK"
mkdir -p "$PROJECT"
cd "$PROJECT"

say "=============================================================="
say "== the review surface: per-hunk attribution and a partial accept"
say "=============================================================="
say "one committed file of forty lines. The agent changes line 3 and line 31, which are far enough"
say "apart to be two hunks. 'You' then take only the second. The first must not be written."

# A committed file, then real agent work in a real sandbox, then a fetch. No model is needed to
# make the change: `moat exec` runs it in the box, which is where the agent's work would happen.
python3 - "$PROJECT" <<'PY'
import sys
open(sys.argv[1] + "/notes.txt", "w").write("\n".join(f"line {i}" for i in range(1, 41)) + "\n")
PY
git init -q -b main .
git config user.email gate@example.com
git config user.name "Gate"
git add -A
git commit -qm "the project as it was"

( cd "$PROJECT" && $M up --quiet --no-detect --no-credential --egress open ) > "$WORK/up.log" 2>&1
if [ $? = 0 ]; then
  pass "the boot" "a real sandbox, keyless"
else
  fail "the boot" "$(tail -3 "$WORK/up.log" | tr '\n' ' ')"
fi

# The agent's work, in the box. `awk` rather than python3: the Alpine image has no python3, and a
# first attempt at this made a commit that changed nothing and reported success.
cat > "$WORK/agent.sh" <<'AGENT'
set -eu
cd /work
awk 'NR == 3 { print "line 3: the agent changed this"; next }
     NR == 31 { print "line 31: the agent changed this too"; next }
     { print }' notes.txt > notes.txt.new
mv notes.txt.new notes.txt
git add -A
git -c user.email=agent@example.com -c user.name=agent commit -qm "agent: two changes, 28 lines apart"
AGENT
( cd "$PROJECT" && $M exec -- sh -c "$(cat "$WORK/agent.sh")" ) > "$WORK/agent.log" 2>&1
( cd "$PROJECT" && $M fetch --quiet ) > "$WORK/fetch.log" 2>&1

# What the agent actually did, in the box, before anything is applied.
( cd "$PROJECT" && $M exec -- sh -c 'cd /work && awk "NR == 3 || NR == 31" notes.txt' ) > "$WORK/in-box.log" 2>&1
say ""
say "--- the agent's lines, read inside the box ---"
scrub < "$WORK/in-box.log" | tee -a "$LOG"
if grep -q "line 3: the agent changed this" "$WORK/in-box.log" && grep -q "line 31: the agent changed this too" "$WORK/in-box.log"; then
  pass "the agent's work" "two changes in the sandbox, 28 lines apart"
else
  fail "the agent's work" "the sandbox does not hold the two changes"
fi

# The digest of the host tree before the accept, so "exactly what was approved" is measured.
before_digest=$(python3 - "$PROJECT" <<'PY'
import hashlib, os, sys
root = sys.argv[1]
h = hashlib.sha256()
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = sorted(d for d in dirnames if d != ".git")
    for name in sorted(filenames):
        full = os.path.join(dirpath, name)
        h.update(os.path.relpath(full, root).encode())
        h.update(open(full, "rb").read())
print(h.hexdigest())
PY
)

say ""
say "--- the review: moat apply --dry-run ---"
( cd "$PROJECT" && $M apply --dry-run ) > "$WORK/review.log" 2>&1
scrub < "$WORK/review.log" | tee -a "$LOG"

# The review must show the file, both hunks, and their line ranges. A review that summarised the
# file would pass every later assertion while telling the user nothing.
if grep -qE "^    hunk 1 +lines [0-9]+-[0-9]+ of your file" "$WORK/review.log" \
   && grep -qE "^    hunk 2 +lines [0-9]+-[0-9]+ of your file" "$WORK/review.log"; then
  pass "the review" "two hunks, each with the range of your file it replaces"
else
  fail "the review" "the review did not present two hunks with their ranges"
fi
if grep -q "line 3: the agent changed this" "$WORK/review.log" \
   && grep -q "line 31: the agent changed this too" "$WORK/review.log"; then
  pass "the review bodies" "both proposed changes are shown, not summarised"
else
  fail "the review bodies" "the proposed lines are not in the review output"
fi
# Anchored on the classification column, not on the word: the review also prints a warning about
# the credential scan, and that line contains "no credential value ... to compare against", so a
# bare `grep conflict` is satisfied by prose rather than by a verdict. Measured — the first version
# of this check failed on a file the planner had correctly called the agent's.
if grep -qE "^  agent +notes\.txt" "$WORK/review.log" && ! grep -qE "^  conflict +notes\.txt" "$WORK/review.log"; then
  pass "the classification" "the planner classified the file as the agent's alone"
else
  fail "the classification" "the file was not classified as an agent-only change"
fi

# --- the same surface from `moat take` ----------------------------------------------------------
#
# The phase is about `moat take` *and* `moat apply`, and they answer different questions: take's
# diffstat is against the host's HEAD, so it names what the agent committed, while this classifies
# the three trees and splits each change into hunks. `--no-verify` keeps it to the review: the
# fixture has no checks of its own, and this section is not about them.
say ""
say "--- moat take: the same review, before anything is decided ---"
( cd "$PROJECT" && $M take --no-verify ) > "$WORK/take.log" 2>&1
take_code=$?
scrub < "$WORK/take.log" | tee -a "$LOG"
if grep -qE "^  agent +notes\.txt +modify" "$WORK/take.log" \
   && grep -qE "^    hunk 1 +lines [0-9]+-[0-9]+ of your file" "$WORK/take.log" \
   && grep -qE "^    hunk 2 +lines [0-9]+-[0-9]+ of your file" "$WORK/take.log"; then
  pass "take's review" "take presents the same per-hunk attribution apply does"
else
  fail "take's review" "take did not present the per-hunk attribution"
fi
# Read-only, and the check that it is: `take` must not have written the agent's lines into the tree
# it just described.
if [ "$take_code" = 0 ] && ! grep -qxF "line 3: the agent changed this" "$PROJECT/notes.txt"; then
  pass "take writes nothing" "the review was shown and the working tree still holds your lines"
else
  fail "take writes nothing" "take exited $take_code, or wrote to the tree it was reviewing"
fi

# --- the partial accept -------------------------------------------------------------------
say ""
say "--- accepting hunk 2 only ---"
( cd "$PROJECT" && $M apply --only notes.txt --hunks 2 ) > "$WORK/apply.log" 2>&1
scrub < "$WORK/apply.log" | tee -a "$LOG"
if grep -q "partially" "$WORK/apply.log"; then
  pass "the partial accept" "moat reported a partial write, not a whole-file one"
else
  fail "the partial accept" "no partial write was reported"
fi

# The gate's assertion, on the bytes.
accepted="line 31: the agent changed this too"
rejected="line 3: the agent changed this"
if grep -qxF "$accepted" "$PROJECT/notes.txt"; then
  pass "the accepted hunk" "line 31 carries the agent's change"
else
  fail "the accepted hunk" "line 31 does not carry the agent's change"
fi
if grep -qxF "$rejected" "$PROJECT/notes.txt"; then
  fail "the rejected hunk" "line 3 was written even though it was not accepted"
else
  pass "the rejected hunk" "line 3 is the host's own line, exactly as it was"
fi
lines=$(wc -l < "$PROJECT/notes.txt")
if [ "$lines" = "40" ]; then
  pass "the file's shape" "still forty lines: a replacement, not an append or a truncation"
else
  fail "the file's shape" "the file has $lines lines, not 40"
fi

# The digest, recomputed with hunk 2's line swapped in: that is the only difference the accept was
# allowed to make, so this is "exactly what the user approved" measured rather than described.
expected_digest=$(python3 - "$PROJECT" "$accepted" <<'PY'
import hashlib, os, sys
root, accepted = sys.argv[1], sys.argv[2]
h = hashlib.sha256()
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = sorted(d for d in dirnames if d != ".git")
    for name in sorted(filenames):
        full = os.path.join(dirpath, name)
        h.update(os.path.relpath(full, root).encode())
        content = open(full, "rb").read()
        if name == "notes.txt":
            content = content.replace(b"line 31\n", accepted.encode() + b"\n")
        h.update(content)
print(h.hexdigest())
PY
)
after_digest=$(python3 - "$PROJECT" <<'PY'
import hashlib, os, sys
root = sys.argv[1]
h = hashlib.sha256()
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = sorted(d for d in dirnames if d != ".git")
    for name in sorted(filenames):
        full = os.path.join(dirpath, name)
        h.update(os.path.relpath(full, root).encode())
        h.update(open(full, "rb").read())
print(h.hexdigest())
PY
)
say ""
say "  digest before the accept   $before_digest"
say "  digest after the accept    $after_digest"
say "  digest with only hunk 2    $expected_digest"
if [ "$before_digest" != "$after_digest" ]; then
  pass "the accept" "changed the tree, which is what it was asked to do"
else
  fail "the accept" "the tree did not change at all"
fi
if [ "$after_digest" = "$expected_digest" ]; then
  pass "exactly what was approved" "the tree equals the tree with hunk 2 and nothing else applied"
else
  fail "exactly what was approved" "the tree holds something other than the approved hunk"
fi

# --- the rest of it, and idempotence ------------------------------------------------------
say ""
say "--- then hunk 1, from a fresh plan ---"
( cd "$PROJECT" && $M apply --only notes.txt ) > "$WORK/apply2.log" 2>&1
scrub < "$WORK/apply2.log" | tee -a "$LOG"
if grep -qxF "$rejected" "$PROJECT/notes.txt" && grep -qxF "$accepted" "$PROJECT/notes.txt"; then
  pass "the second accept" "line 3 is now the agent's too, and line 31 still is"
else
  fail "the second accept" "the file does not hold both accepted hunks"
fi
( cd "$PROJECT" && $M apply --dry-run ) > "$WORK/final.log" 2>&1
if grep -q "nothing to apply" "$WORK/final.log"; then
  pass "convergence" "the directory now matches the sandbox; there is nothing left to review"
else
  fail "convergence" "something is still pending after both hunks were accepted"
fi

# --- a selection excludes everything it does not name ------------------------------------------
#
# The agent now changes two files: line 20 of `notes.txt` (which has converged, so the host matches
# the sandbox and this is a clean agent-only edit) and a new `other.txt`. `--only notes.txt` writes
# the first and must leave the second alone.
#
# This is the CLI-level promise (`--only X` writes X and nothing else); the writer-level guard that
# backs it, and the fact that it is load-bearing, is measured in `test/unit/review.test.ts`, where
# deleting it fails a test. Both levels are here on purpose: the CLI filters the selection list
# before it reaches the writer, so an end-to-end run cannot see the writer's guard on its own.
say ""
say "--- a second change the selection does not name ---"
( cd "$PROJECT" && $M exec -- sh -c 'cd /work && printf "the agent wrote this too\n" > other.txt && awk "NR == 20 { print \"line 20: the agent came back\"; next } { print }" notes.txt > n && mv n notes.txt && git add -A && git -c user.email=agent@example.com -c user.name=agent commit -qm "agent: a second file, and line 20"' ) >/dev/null 2>&1
( cd "$PROJECT" && $M fetch --quiet ) >/dev/null 2>&1
( cd "$PROJECT" && $M apply --only notes.txt ) > "$WORK/only.log" 2>&1
scrub < "$WORK/only.log" | tee -a "$LOG"
# The control: both changes are really pending, so "it was not written" means moat declined it and
# not that there was nothing to decline. Without this the check passes on an empty plan. Neither the
# verdict nor the operation is pinned: `notes.txt` arrives as `both … merge` here — you took the
# first two hunks, so the planner merges the third — while `other.txt` is `agent … add`, and this
# check is about the plan holding two changes rather than about which verdict each one got.
if grep -qE "^  [a-z]+ +other\.txt +add" "$WORK/only.log" \
   && grep -qE "^  [a-z]+ +notes\.txt +(modify|merge)" "$WORK/only.log"; then
  pass "the pending changes" "two changes were offered and the selection named one of them"
else
  fail "the pending changes" "the plan did not contain both changes, so the check below is vacuous"
fi
if [ ! -e "$PROJECT/other.txt" ]; then
  pass "the unselected change" "--only notes.txt did not write the file it did not name"
else
  fail "the unselected change" "a file the selection never named was written to the host tree"
fi
if grep -qxF "line 20: the agent came back" "$PROJECT/notes.txt"; then
  pass "the named change" "the file the selection did name was written"
else
  fail "the named change" "--only notes.txt did not write notes.txt"
fi
# An addition's hunk is `@@ -0,0 +1,N @@`, so its destination range is empty. Printing the two
# numbers gave "lines 1-0 of your file" — a range in a file that is not there — which is what the
# first run's evidence said. Anything with a start above its end is the same defect.
if grep -qE "^    hunk [0-9]+ +a new file$" "$WORK/only.log" \
   && ! grep -qE "^    hunk [0-9]+ +lines [0-9]+-0 of your file$" "$WORK/only.log"; then
  pass "an added file's hunk" "the review names no line range for a file you do not have yet"
else
  fail "an added file's hunk" "the review printed a destination range for an added file"
fi

# --- conflict safety, still ------------------------------------------------------------------
say ""
say "--- a conflict is never written, whatever the selection ---"
( cd "$PROJECT" && $M exec -- sh -c 'cd /work && awk "NR == 3 { print \"line 3: the agent again\"; next } { print }" notes.txt > n && mv n notes.txt && git add -A && git -c user.email=a@e.com -c user.name=a commit -qm again' ) >/dev/null 2>&1
python3 - "$PROJECT" <<'PY'
import sys
path = sys.argv[1] + "/notes.txt"
lines = open(path).read().split("\n")
lines[2] = "line 3: you changed this while the agent did"
open(path, "w").write("\n".join(lines))
PY
( cd "$PROJECT" && $M fetch --quiet ) >/dev/null 2>&1
( cd "$PROJECT" && $M apply --dry-run ) > "$WORK/conflict.log" 2>&1
if grep -qE "^  conflict +notes\.txt" "$WORK/conflict.log" && grep -q "not written" "$WORK/conflict.log"; then
  pass "the conflict" "the review says the path is a conflict and will not be written"
else
  fail "the conflict" "a both-sides change was not presented as a conflict"
fi
( cd "$PROJECT" && $M apply --only notes.txt ) > "$WORK/conflict-apply.log" 2>&1
if grep -qxF "line 3: you changed this while the agent did" "$PROJECT/notes.txt"; then
  pass "the conflict, after a selection" "your line is still yours; the conflict was not written"
else
  fail "the conflict, after a selection" "the conflicting file was written"
fi

echo "" | tee -a "$LOG"
echo "review evidence written to $LOG" | tee -a "$LOG"
verdict
exit $?
