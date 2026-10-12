#!/usr/bin/env bash
# Shared by the focused Pi regressions. Every environment is in a unique temp
# store; only the digest-checked download cache is shared. Never clean ~/.moat/envs.
pi_fixture() {
  SUITE="$1"
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  WORK="$(mktemp -d "/tmp/moat-$SUITE.XXXXXX")"
  PROJECT="$WORK/project"
  EVIDENCE="$REPO/test/evidence/$SUITE.txt"
  RECORD="$WORK/provider.jsonl"
  MOCK_PID=""
  MOAT=(node "$REPO/cmd/main.ts")
  local cache="${MOAT_HOME:-$HOME/.moat}/cache"
  mkdir -p "$cache" "$WORK/moat-home" "$PROJECT" "$(dirname "$EVIDENCE")"
  ln -s "$(realpath "$cache")" "$WORK/moat-home/cache"
  export MOAT_HOME="$WORK/moat-home" NO_COLOR=1
  : > "$EVIDENCE"
  trap pi_cleanup EXIT
}
pi_cleanup() {
  local rc=${1:-$?}
  trap - EXIT
  if [[ -n "$MOCK_PID" ]]; then kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true; fi
  (cd "$PROJECT" && "${MOAT[@]}" down --quiet) >/dev/null 2>&1 || true
  (cd "$PROJECT" && "${MOAT[@]}" destroy --yes --quiet) >/dev/null 2>&1 || true
  if [[ "$rc" != 0 ]]; then
    pi_say "$SUITE: FAILED (diagnostics retained in $WORK)"
  fi
  exit "$rc"
}
pi_say() { printf '%s\n' "$*" | tee -a "$EVIDENCE"; }
pi_run() {
  local label="$1"; shift
  if "$@" > "$WORK/$label.out" 2> "$WORK/$label.err"; then
    return 0
  else
    local rc=$?
    printf '%s (exit %s); bounded diagnostics:\n' "$label" "$rc" >&2
    tail -c 8192 "$WORK/$label.err" "$WORK/$label.out" >&2
    return "$rc"
  fi
}
pi_stub() {
  if [[ -n "$MOCK_PID" ]]; then kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true; fi
  : > "$RECORD"
  node "$REPO/stub/mock-responses.mjs" --port "${MOCK_PORT:-0}" --host "${2:-127.0.0.1}" --script "$1" --record "$RECORD" > "$WORK/stub.log" 2>&1 &
  MOCK_PID=$!
  for _ in {1..100}; do
    if grep -q 'listening on' "$WORK/stub.log"; then
      PORT=$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8"); console.log(new URL(s.match(/listening on (\S+)/)[1]).port)' "$WORK/stub.log")
      return 0
    fi
    kill -0 "$MOCK_PID" 2>/dev/null || break
    sleep .1
  done
  printf 'stub did not start; see %s\n' "$WORK/stub.log" >&2
  return 1
}
pi_hash() {
  node --input-type=module -e "import {hashTree} from '$REPO/lib/hash.ts'; console.log(hashTree(process.cwd()).digest)"
}
pi_env_id() {
  node --input-type=module -e "import {envPaths} from '$REPO/lib/paths.ts'; console.log(envPaths(process.cwd()).id)"
}
