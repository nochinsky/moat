import fs from "node:fs"
import path from "node:path"

import { partPath, type EnvPaths } from "../lib/paths.ts"
import { processStartTime } from "./launcher.ts"

/**
 * The marker that says "this environment is being booted right now".
 *
 * A boot is the only operation that rebuilds the rootfs, rewrites state.json and
 * eventually records a pid, and it spends most of its time (provisioning,
 * copy-in, package installs, the readiness wait) looking exactly like an idle
 * environment: state.json says stopped with no pid, because that is what it said
 * before the boot started. Measured, that window is where `moat down` reported
 * "sandbox is not running", `moat destroy` deleted the rootfs out from under the
 * boot, and a second `moat up` booted a second box over the same rootfs while
 * state.json recorded whichever finished last -- leaving the other sandbox alive
 * with nothing tracking it.
 *
 * The record is a pid *and* its start time, the same identity rule the sandbox pid
 * follows: a marker left behind by a crash, a ctrl-c or a `log.fail` must not block
 * the environment forever, and after a reboot that pid may belong to something
 * else. `bootInFlight` therefore forgets a marker whose process is gone.
 *
 * Only the long-running boot takes it. Ephemeral boots (`moat exec`, `doctor`,
 * `shell`, the checks runner) deliberately do not: they are tolerable in parallel
 * by design (see AGENTS.md), and serialising them would be a worse trade.
 */
export type BootRecord = {
  /** The host process doing the boot. */
  pid: number
  /** Its start time from `/proc/<pid>/stat`, so a reused pid is not it. */
  pidStart: string | null
  startedAt: string
  /** What it is doing, for the message the other command prints. */
  command: string
}

export function bootMarkerPath(p: EnvPaths): string {
  return path.join(p.dir, "runtime", "boot.json")
}

function readMarker(p: EnvPaths): BootRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(bootMarkerPath(p), "utf8")) as BootRecord
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) return null
    if (typeof raw.startedAt !== "string") return null
    return raw
  } catch {
    return null
  }
}

/**
 * The boot another process is doing right now, or null.
 *
 * A marker whose process is gone is removed here, so no caller has to know how to
 * clean up after a boot that died.
 */
export function bootInFlight(p: EnvPaths): BootRecord | null {
  const record = readMarker(p)
  if (!record) return null
  const start = processStartTime(record.pid)
  if (start === null) {
    fs.rmSync(bootMarkerPath(p), { force: true })
    return null
  }
  if (record.pidStart && start !== record.pidStart) {
    fs.rmSync(bootMarkerPath(p), { force: true })
    return null
  }
  return record
}

/** Record that this process is booting the environment. */
export function beginBoot(p: EnvPaths, command: string): void {
  const marker = bootMarkerPath(p)
  fs.mkdirSync(path.dirname(marker), { recursive: true })
  const record: BootRecord = {
    pid: process.pid,
    pidStart: processStartTime(process.pid),
    startedAt: new Date().toISOString(),
    command,
  }
  const tmp = partPath(marker)
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, marker)
}

/** Remove the marker, but only while it is still this process\'s. */
export function endBoot(p: EnvPaths): void {
  const record = readMarker(p)
  if (record && record.pid !== process.pid) return
  fs.rmSync(bootMarkerPath(p), { force: true })
}

/** Seconds since a boot started, for the message another command prints. */
export function bootAgeSeconds(record: BootRecord, now = Date.now()): number {
  const started = Date.parse(record.startedAt)
  if (!Number.isFinite(started)) return 0
  return Math.max(0, Math.round((now - started) / 1000))
}

export type BootWait = "none" | "finished" | "timeout"

/**
 * Wait for a boot in flight to finish.
 *
 * `none` when nothing is booting (or the marker is this process\'s own),
 * `finished` when the other boot cleared its marker or died, `timeout` when it is
 * still going. Polling is the right granularity: the marker is a file, the boot
 * can take minutes, and this is a user-facing command either way.
 */
export async function waitForBoot(
  p: EnvPaths,
  opts: { timeoutMs: number; onWait?: (record: BootRecord) => void; pollMs?: number },
): Promise<BootWait> {
  const first = bootInFlight(p)
  if (!first || first.pid === process.pid) return "none"
  opts.onWait?.(first)
  const deadline = Date.now() + opts.timeoutMs
  const pollMs = opts.pollMs ?? 250
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    if (!bootInFlight(p)) return "finished"
  }
  return "timeout"
}
