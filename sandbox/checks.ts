import type { Check } from "../lib/detect.ts"
import type { EnvPaths } from "../lib/paths.ts"
import { SANDBOX_WORKDIR } from "../lib/pins.ts"
import { runInSandbox } from "./launcher.ts"

/**
 * Run the project's own checks inside the sandbox.
 *
 * This exists because an agent saying "the tests pass" is a claim, not evidence.
 * With the real DeepSeek run, the agent reported `pass 6, fail 0` and the only
 * reason that is trustworthy is that the result was re-run independently. Doing
 * that by hand is exactly the kind of thing that stops happening after the first
 * week, so moat does it.
 *
 * No model is involved. moat runs the command the project itself declares and
 * reports what actually happened.
 */

export type CheckResult = {
  label: string
  command: string
  kind: Check["kind"]
  ok: boolean
  code: number
  /** Last few lines, which is where test runners put the verdict. */
  output: string
  ms: number
  timedOut: boolean
}

const DEFAULT_TIMEOUT_SECONDS = 600

export async function runChecks(
  paths: EnvPaths,
  checks: Check[],
  opts: { timeoutSeconds?: number; onOutput?: (chunk: string) => void } = {},
): Promise<CheckResult[]> {
  if (checks.length === 0) return []
  const timeout = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
  const results: CheckResult[] = []

  for (const check of checks) {
    const started = Date.now()
    // `timeout` is coreutils and present in the base image, so a hung test suite
    // cannot hang moat.
    const script = `#!/bin/sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
export CI=1
cd ${SANDBOX_WORKDIR}
echo "[moat] $ ${check.command}"
timeout ${timeout} sh -c ${JSON.stringify(check.command)}
code=$?
if [ "$code" = "124" ]; then echo "[moat] TIMED OUT after ${timeout}s"; fi
echo "[moat] exit $code"
exit $code
`
    const result = await runInSandbox(paths, script, { onOutput: opts.onOutput })
    const timedOut = result.output.includes("[moat] TIMED OUT")
    const lines = result.output.split("\n").filter((line) => line.trim().length > 0)
    results.push({
      label: check.label,
      command: check.command,
      kind: check.kind,
      ok: result.code === 0,
      code: result.code,
      output: lines.slice(-12).join("\n"),
      ms: Date.now() - started,
      timedOut,
    })
  }

  return results
}

/** One line per check, for the summary a user actually reads. */
export function summarise(results: CheckResult[]): string {
  return results
    .map((r) => {
      if (r.timedOut) return `${r.label} timed out`
      const verdict = r.ok ? "passed" : `FAILED (exit ${r.code})`
      return `${r.label} ${verdict}`
    })
    .join(", ")
}
