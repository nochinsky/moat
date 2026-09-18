import { AUDIT_LOG, BUNDLE_CONFIG, SANDBOX_WORKDIR } from "../lib/pins.ts"

/**
 * The script that boots `opencode serve` inside the sandbox.
 *
 * Two properties matter here and both are checkable after the fact:
 *
 *  1. It contains no secret. The credential is referenced as a shell variable
 *     (`$MOAT_INJECTED_CREDENTIAL`) and arrives through the process environment
 *     supplied by the host at spawn time. `grep` the script and the whole rootfs
 *     for the credential value and you find nothing.
 *
 *  2. Configuration cannot be influenced from outside the bundle.
 *     `OPENCODE_CONFIG` pins the file, `OPENCODE_DISABLE_PROJECT_CONFIG=1`
 *     stops a project `opencode.json` from re-widening or re-narrowing the tool
 *     set, and `OPENCODE_CONFIG_DIR` points at a directory moat owns so no
 *     ambient host/global config is read.
 *
 *     `OPENCODE_CLIENT=moat` keeps opencode from adding TUI-oriented tools, but
 *     it also drops `question` (packages/opencode/src/tool/registry.ts,
 *     `questionEnabled` checks `flags.client`). `OPENCODE_ENABLE_QUESTION_TOOL=1`
 *     is the supported way to get that one back, and the bundle curates it:
 *     moat tells the agent whether anyone is listening, and rejects the question
 *     when nobody is, so it can never hang waiting for an answer that cannot
 *     come.
 */

export type ServeOptions = {
  port: number
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR"
  /** Seconds after which the injected credential is considered dead and the agent is stopped. */
  credentialTtlSeconds: number | null
  /** Override the tool to exec; used by tests to run a shell instead of the server. */
  execOverride?: string
}

const ALLOWED_LOG_LEVELS = new Set(["DEBUG", "INFO", "WARN", "ERROR"])

export function serveEntryScript(opts: ServeOptions): string {
  const level = opts.logLevel && ALLOWED_LOG_LEVELS.has(opts.logLevel) ? opts.logLevel : "INFO"
  const ttl = opts.credentialTtlSeconds && opts.credentialTtlSeconds > 0 ? Math.floor(opts.credentialTtlSeconds) : 0
  const agent = opts.execOverride ?? `opencode serve --port ${opts.port} --hostname 127.0.0.1 --print-logs --log-level ${level}`

  // One line, no backslash continuations: an earlier version used them and the
  // escaping survived into the generated script, silently joining every
  // assignment into a single mangled command.
  const agentEnv = [
    `OPENCODE_CONFIG=${BUNDLE_CONFIG}`,
    "OPENCODE_CONFIG_DIR=/root/.config/opencode",
    "OPENCODE_DISABLE_PROJECT_CONFIG=1",
    "OPENCODE_DISABLE_AUTOUPDATE=1",
    "OPENCODE_DISABLE_TERMINAL_TITLE=1",
    "OPENCODE_SERVER_USERNAME=opencode",
    "OPENCODE_CLIENT=moat",
    // OPENCODE_CLIENT=moat is what keeps TUI-oriented tools out of the list, but
    // it also drops `question` (registry.ts `questionEnabled` checks flags.client).
    // This is the supported way to get that one back, and the bundle curates it.
    "OPENCODE_ENABLE_QUESTION_TOOL=1",
    `MOAT_AUDIT_LOG=${AUDIT_LOG}`,
  ].join(" ")

  // Credential lifetime enforcement.
  //
  // Two things here are load-bearing, and both were learned from a failing
  // verification run rather than from reading code:
  //
  //  1. The agent is a CHILD of this script, not `exec`d. The kernel refuses to
  //     apply a signal's default action to the PID-namespace init process, so
  //     `kill -TERM 1` is silently a no-op and the box outlives its credential.
  //  2. The watchdog is spawned AFTER the pid is known. An earlier version
  //     started it before `AGENT_PID=$!`, so under `set -u` the subshell died
  //     with "AGENT_PID: parameter not set" at the exact moment it mattered.
  const watchdog = ttl
    ? `(
  sleep ${ttl}
  echo "[moat] injected credential expired (ttl=${ttl}s); stopping agent"
  kill -TERM "$AGENT_PID" 2>/dev/null || true
  sleep 5
  kill -KILL "$AGENT_PID" 2>/dev/null || true
) &
`
    : ""

  return `#!/bin/sh
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
mkdir -p /var/log/moat
echo "[moat] sandbox boot $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[moat] kernel=$(uname -r) rootfs=$(cat /etc/alpine-release 2>/dev/null || echo unknown)"
echo "[moat] credential fingerprint=\${MOAT_CREDENTIAL_FINGERPRINT:-none} expires=\${MOAT_CREDENTIAL_EXPIRES_AT:-never}"
cd ${SANDBOX_WORKDIR}
echo "[moat] starting opencode serve on 127.0.0.1:${opts.port}"
env ${agentEnv} ${agent} &
AGENT_PID=$!
echo "[moat] agent pid=$AGENT_PID"
${watchdog}wait "$AGENT_PID"
echo "[moat] agent exited with status $?"
`
}
