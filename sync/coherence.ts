import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { detectChecks } from "../lib/detect.ts"
import type { EnvPaths } from "../lib/paths.ts"
import type { EgressMode } from "../lib/pins.ts"
import { runChecks, type CheckResult } from "../sandbox/checks.ts"
import { applySelection, type ApplyPlan, type Selection } from "./apply.ts"
import { copyIn } from "./copyin.ts"

/**
 * Does the part you accepted still hold together?
 *
 * The review splits a change into hunks and lets the user take some of them. That is the
 * product's whole point and it is also the one way it can hand back a broken tree: accept
 * hunk 2 and reject the hunk in another file that makes it compile, and `moat apply` writes a
 * state no program has ever been in. Before this existed, moat said so as a documented
 * limitation and wrote it anyway.
 *
 * This runs the project's own checks against **exactly the subset about to be written** — not
 * the agent's full tree, which `moat verify` already covers — before anything reaches the host.
 *
 * How the subset is built, and why it takes two copies:
 *
 *   candidate = the host project as it is now (HEAD + uncommitted work)  -- `copyIn`
 *               with the accepted hunks written into it                    -- `applySelection`
 *
 * The host project, not the sandbox's `/work`, because those are different trees: `/work` is
 * what the agent changed, the candidate is what the user is about to accept, and the two differ
 * by every hunk the user rejected. The candidate is assembled on the host and then copied *into*
 * the environment's rootfs, so the checks run through the same `runInSandbox` every other check
 * uses and the host project is never touched (SPEC §2.2, invariant 4). The scratch tree is
 * removed afterwards whether the checks pass or fail.
 */

export type CoherenceOutcome = {
  /** False when there was nothing to run: no checks detected, or the subset could not be built. */
  ran: boolean
  ok: boolean
  /** Why it did not run, when it did not. */
  reason?: string
  results: CheckResult[]
}

export async function checkCoherence(
  paths: EnvPaths,
  plan: ApplyPlan,
  selections: Selection[],
  opts: {
    timeoutSeconds?: number
    onOutput?: (chunk: string) => void
    egress?: EgressMode
    slirpBinary?: string
  } = {},
): Promise<CoherenceOutcome> {
  const checks = detectChecks(paths.projectDir)
  if (checks.length === 0) {
    return { ran: false, ok: true, reason: "no test, lint or typecheck command found for this project", results: [] }
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "moat-coherence-"))
  const candidate = path.join(scratch, "candidate")
  const boxName = `moat-verify-${crypto.randomBytes(4).toString("hex")}`
  const boxTree = path.join(paths.rootfs, boxName)

  try {
    // 1. The host project as it stands, HEAD plus uncommitted work. `copyIn` is reused rather than
    //    a plain copy so deletes, renames, symlinks and binaries come out the same way they do on
    //    the real boot — the candidate has to be the tree the checks would see.
    await copyIn(stage(paths, scratch, "candidate", paths.projectDir, candidate), { quiet: true })

    // 2. Write exactly the accepted subset into the copy, with the same writer `moat apply` uses.
    //    Nothing here touches `paths.projectDir`.
    const written = await applySelection({ ...paths, projectDir: candidate }, plan, selections)
    if (written.skipped.length > 0) {
      // The subset could not be built at all (a stale plan, a source that moved). Reporting it as a
      // failed check is the honest answer: the alternative is to write something other than the
      // subset the user reviewed.
      return {
        ran: false,
        ok: false,
        reason:
          "the accepted subset could not be built: " +
          written.skipped.map((entry) => `${entry.path} (${entry.reason})`).join(", "),
        results: [],
      }
    }

    // 3. Put it in the box. The sandbox's `/` is the rootfs, so the tree is at `/moat-verify-…`.
    await copyIn(stage(paths, scratch, "box", candidate, boxTree), { quiet: true })

    // 4. Run the project's own checks against it, in the same kind of network as the environment.
    const results = await runChecks(paths, checks, {
      workdir: `/${boxName}`,
      timeoutSeconds: opts.timeoutSeconds,
      onOutput: opts.onOutput,
      egress: opts.egress,
      slirpBinary: opts.slirpBinary,
    })
    return { ran: true, ok: results.every((result) => result.ok), results }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
    // The scratch tree lives inside the rootfs, so it has to go even when a check threw: leaving it
    // would put a copy of the project, with the accepted changes, inside the agent's box.
    fs.rmSync(boxTree, { recursive: true, force: true })
  }
}

/**
 * An `EnvPaths` for a copy that is not the environment itself.
 *
 * Only the fields `copyIn` and `applySelection` read are redirected; the rest is carried through
 * rather than fabricated, so a caller cannot pass a half-built object.
 */
function stage(base: EnvPaths, scratch: string, name: string, projectDir: string, work: string): EnvPaths {
  return { ...base, projectDir, work, dir: path.join(scratch, name) }
}
