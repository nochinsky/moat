import { CLAUDE_VERSION, CODEX_VERSION, SANDBOX_WORKDIR, type RuntimeId } from "../lib/pins.ts"
import { shellQuote } from "../lib/shell.ts"
import { READY_MARKER } from "../sandbox/launcher.ts"
import { claudeExecBody, claudeTuiBody, parseClaudeEvents } from "./claude.ts"
import { codexExecBody, codexTuiBody, parseCodexEvents } from "./codex.ts"
import { describeTurn, type Turn } from "./turn.ts"

/**
 * The runtime seam: which agent CLI moat drives, and the four things that differ between them.
 *
 * `docs/SEAM.md` describes this boundary and `docs/RUNTIMES.md` records what adding a runtime
 * costs. The shape here is deliberately small, because it was extracted by the second
 * implementation rather than designed ahead of it — the lesson from the Phase 4 spike and from the
 * Claude policy work in `docs/RUNTIMES.md` is that guessing the seam produces the wrong seam.
 *
 * What is **not** in the seam, and why:
 *
 *  - the **keepalive entry script** — a box that holds itself open and enforces the credential
 *    deadline does not care which CLI it is holding it for, so there is one script
 *    (`keepaliveEntryScript`) rather than one per runtime;
 *  - the **provider and the credential** — invariant 8 forbids guessing, and the provider is the
 *    user's own configuration; a runtime only names the variables it reads, and the CLI renders
 *    those;
 *  - the **config and brief files** — every agent has its own format (`AGENTS.md` vs `CLAUDE.md`,
 *    TOML vs JSON), so each runtime owns its renderer (`bundle/codex.ts`, `bundle/claude.ts`).
 */

export type { RuntimeId }

export type RuntimeSpec = {
  id: RuntimeId
  /** A word for the report, e.g. `codex (deepseek/deepseek-flash)`. */
  label: string
  /** Where the pinned binary lands inside the rootfs. */
  binary: string
  /** The pinned version, for the image cache key and the report. */
  version: string
  /** One non-interactive turn. The prompt is moat's, already resolved. */
  execBody(prompt: string): string
  /** The runtime's own TUI on the terminal moat inherited. */
  tuiBody(prompt?: string): string
  /** The JSONL stream a turn produced, in the shared shape (`bundle/turn.ts`). */
  parse(text: string): Turn
  describe(turn: Turn): string
}

/** The runtime a boot uses unless it is told otherwise. */
export const DEFAULT_RUNTIME: RuntimeId = "codex"

export const RUNTIMES: Record<RuntimeId, RuntimeSpec> = {
  codex: {
    id: "codex",
    label: "codex",
    binary: "/usr/local/bin/codex",
    version: CODEX_VERSION,
    execBody: codexExecBody,
    tuiBody: codexTuiBody,
    parse: parseCodexEvents,
    describe: describeTurn,
  },
  claude: {
    id: "claude",
    label: "claude",
    binary: "/usr/local/bin/claude",
    version: CLAUDE_VERSION,
    execBody: claudeExecBody,
    tuiBody: claudeTuiBody,
    parse: parseClaudeEvents,
    describe: describeTurn,
  },
}

export const RUNTIME_IDS: readonly RuntimeId[] = Object.keys(RUNTIMES) as RuntimeId[]

/**
 * The runtime for an id, refusing anything else by name.
 *
 * A flag that named a runtime moat does not ship must not fall back to the default: silently
 * booting Codex for `--runtime gemini` is the kind of guess invariant 8 is about, one layer down.
 */
export function resolveRuntime(id: string): RuntimeSpec {
  const spec = (RUNTIMES as Record<string, RuntimeSpec | undefined>)[id]
  if (!spec) {
    throw new Error(`unknown runtime "${id}". moat ships: ${RUNTIME_IDS.join(", ")}.`)
  }
  return spec
}

/**
 * The long-running box, whichever runtime it is holding open.
 *
 * A CLI is not a server: there is nothing to wait for and nothing listening, so the box exists so
 * `moat status`, `down` and `destroy` keep their meaning, and every task and TUI runs in its own
 * ephemeral boot of the same rootfs.
 *
 * It also enforces the credential deadline, which is the box's own promise: the timestamp comes
 * from the host (`MOAT_CREDENTIAL_EXPIRES_EPOCH`) and the box exits when it passes. A credential
 * that is already dead at boot stops the box rather than leaving one that cannot call a model, and
 * the deadline is checked **before** the readiness line — with the ready line first, a box whose
 * credential was already dead printed ready and then exited, so `moat up` waited, saw the marker,
 * and recorded a running sandbox that was already gone.
 */
export function keepaliveEntryScript(): string {
  return `#!/bin/sh
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
EXPIRES_EPOCH=\${MOAT_CREDENTIAL_EXPIRES_EPOCH:-0}
REMAIN=0
if [ "$EXPIRES_EPOCH" -gt 0 ]; then
  REMAIN=$((EXPIRES_EPOCH - $(date +%s)))
  if [ "$REMAIN" -le 0 ]; then
    echo "[moat] the injected credential expired before the box started; stopping"
    exit 0
  fi
fi
echo "${READY_MARKER} (pid $$)"
if [ "$EXPIRES_EPOCH" -gt 0 ]; then
  echo "[moat] the injected credential expires in \${REMAIN}s; the box stops then"
  sleep "$REMAIN"
  echo "[moat] injected credential expired; stopping the sandbox"
  exit 0
fi
exec sleep 2147483647
`
}

/**
 * The line a boot waits for before it reports the sandbox ready.
 *
 * It used to read `codex runtime ready`, which made the *second* runtime wait on a string naming
 * the first. The text is runtime-neutral now; `READY_MARKER` in `sandbox/launcher.ts` is the same
 * constant the waiter greps for (`ready-check.test.ts` pins the wait).
 */

/** The working directory every runtime's body script runs in. */
export const RUNTIME_WORKDIR = SANDBOX_WORKDIR

/** Exported for tests that want the shell-quoting the bodies use. */
export { shellQuote }
