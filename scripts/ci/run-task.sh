#!/usr/bin/env bash
#
# One unattended moat task, for CI.
#
# This is the whole of what the `moat` GitHub Action does, kept in a script on purpose: a composite
# action is YAML nobody can run locally, and this has two branches that both have to be provable —
# "this host can sandbox, run the task" and "this host cannot, say why and stop".
#
# **GitHub-hosted runners cannot run this.** Measured in this repository's own CI: on
# `ubuntu-latest`, `moat doctor --json` reports `"userns": false` with
# "unprivileged user namespaces are unavailable: `unshare --user --map-root-user` could not mount a
# tmpfs", and lifting AppArmor (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`)
# does not change it, because the runner's own confinement kills `unshare`. So this is for a
# **self-hosted** runner, or any Linux host where `bash test/portability-spike.sh` section 2 says
# MEASURED. `docs/CI.md` has the evidence and `docs/PORTABILITY.md` the analysis.
#
# Environment (the action's inputs land here):
#   MOAT            how to invoke the CLI            (default: npx -y moat-sandbox)
#   TASK            the prompt for the agent         (required)
#   MOAT_ARGS       extra flags, e.g. "--profile node --runtime claude"
#   OUTPUT_DIR      where the logs and the review go (default: ./moat-ci)
#
# Exit status:
#   0  the task ran and the review was written
#   1  the task failed, or the review could not be produced
#   2  this host cannot sandbox — the refusal names the reason and changes nothing
set -uo pipefail

MOAT="${MOAT:-npx -y moat-sandbox}"
TASK="${TASK:-}"
OUTPUT_DIR="${OUTPUT_DIR:-moat-ci}"
# shellcheck disable=SC2206
MOAT_ARGS=(${MOAT_ARGS:-})

if [ -z "$TASK" ]; then
  echo "moat-ci: TASK is empty; nothing to do" >&2
  exit 2
fi

mkdir -p "$OUTPUT_DIR"

say() { printf '%s\n' "$*" | tee -a "$OUTPUT_DIR/ci.log"; }

# ---------------------------------------------------------------------------
# 1. Can this host sandbox at all?
#
# Asked first and answered from `moat doctor`'s own contract rather than by trying a boot: a host
# without unprivileged user namespaces fails much later and much less clearly otherwise, and the
# failure reads like a moat bug rather than a host limitation. The doctor already knows the reason,
# so the reason is what is printed.
# ---------------------------------------------------------------------------
say "== moat doctor"
if ! $MOAT doctor --json > "$OUTPUT_DIR/doctor.json" 2>"$OUTPUT_DIR/doctor.err"; then
  say "moat-ci: \`moat doctor\` itself failed:"
  sed 's/^/  /' "$OUTPUT_DIR/doctor.err" | tee -a "$OUTPUT_DIR/ci.log"
  exit 2
fi

userns=$(node -e '
  let s = ""
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const j = JSON.parse(s)
      process.stdout.write(j?.host?.userns === true ? "yes" : "no")
    } catch {
      process.stdout.write("unknown")
    }
  })
' < "$OUTPUT_DIR/doctor.json")

if [ "$userns" != "yes" ]; then
  say "moat-ci: this host cannot run the sandbox (userns=$userns). Nothing was run."
  say ""
  say "  moat has no host fallback: it isolates with unshare + mount + chroot and refuses"
  say "  without unprivileged user namespaces. GitHub-hosted runners are in this category —"
  say "  see docs/CI.md — so this needs a self-hosted runner. To check a host:"
  say "      bash test/portability-spike.sh"
  say ""
  node -e '
    let s = ""
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const problems = JSON.parse(s)?.host?.problems ?? []
        for (const p of problems) process.stdout.write("  " + p + "\n")
      } catch {}
    })
  ' < "$OUTPUT_DIR/doctor.json" | tee -a "$OUTPUT_DIR/ci.log"
  exit 2
fi
say "host can sandbox (userns=yes)"

# ---------------------------------------------------------------------------
# 2. The task, unattended.
# ---------------------------------------------------------------------------
say ""
say "== moat run"
set +e
# No stdin: this runs in a pipeline, where an inherited stdin is a pipe that may never close and
# `moat` may read (a prompt, a confirmation). Redirecting from /dev/null is what makes the script
# safe to run unattended — without it the first version of this script hung here.
$MOAT run "$TASK" "${MOAT_ARGS[@]}" < /dev/null > "$OUTPUT_DIR/task.log" 2>&1
task_code=$?
set -e
tail -30 "$OUTPUT_DIR/task.log" | tee -a "$OUTPUT_DIR/ci.log"

# ---------------------------------------------------------------------------
# 3. The review — the part a human reads.
#
# `moat take` fetches the agent's branch, classifies the three trees and runs the project's own
# checks. It is read-only: nothing reaches the working tree without a separate `moat apply`, which
# is why a CI run can produce a review without the host project being touched (§2.2).
# ---------------------------------------------------------------------------
say ""
say "== moat take (the review; the tree is not written)"
set +e
$MOAT take --quiet < /dev/null > "$OUTPUT_DIR/review.txt" 2>&1
take_code=$?
set -e
tail -40 "$OUTPUT_DIR/review.txt" | tee -a "$OUTPUT_DIR/ci.log"

say ""
if [ "$task_code" != "0" ]; then
  say "moat-ci: the task failed (exit $task_code). The logs above and in $OUTPUT_DIR are the record."
  exit 1
fi
if [ "$take_code" != "0" ]; then
  say "moat-ci: the task ran but the review failed (exit $take_code) — see $OUTPUT_DIR/review.txt"
  exit 1
fi
say "moat-ci: the task ran and the review is in $OUTPUT_DIR/review.txt (the host tree was not written)"
exit 0
