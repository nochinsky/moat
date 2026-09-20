import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

import * as log from "../lib/log.ts"
import { run } from "../lib/shell.ts"
import { SANITIZED_GIT_ENV } from "../lib/git.ts"
import { stripAnsi } from "../lib/terminal.ts"
import { CREDENTIAL_ENV_NAMES, readStore, type Store } from "../secrets/broker.ts"
import { readState } from "../sandbox/state.ts"

/**
 * Copy-out credential scan.
 *
 * The agent has to be able to read the credential — it calls the model with it — and
 * the brief tells it not to print, commit or send it. Nothing checked: `moat fetch`
 * copied every object the agent committed into the host repository, and `moat apply`
 * wrote the agent's files into the user's working tree, with no scan at all. A key
 * pasted into a config file, or written to `.env` "to make it work", travelled to the
 * host and on to the next push. Copy-*in* has warned about secret-shaped paths since
 * the beginning; copy-out warned about nothing.
 *
 * This is a named exposure, not a boundary. It compares against the credential values
 * the host can see *at this moment* — the environment names moat itself reads, and the
 * credential store — and it does not stop the copy. It cannot see a key that was
 * rotated between the boot and the fetch, and it does not look for secrets the agent
 * found somewhere else. docs/SPEC.md §4 says what it does and does not cover.
 */

/**
 * The credential values this host can see right now.
 *
 * Short values are dropped: matching "abc" would fire on ordinary text and turn the
 * warning into noise nobody reads. The store read is tolerant on purpose — a
 * world-readable credentials file is the boot path's error to report, and fetching
 * must not fail because of it.
 *
 * `opts.alsoNames` are the variable names the environment's credential was actually
 * injected under, read from state.json (`CredentialRecord.sourceEnvVars`). They exist
 * because `--credential-env TEAM_KEY` is a supported way to pass a key, and the scan
 * used to look only at the two names moat knows by convention: a key passed that way
 * was invisible, so a key committed into the project came back with no warning — the
 * one outcome this scan exists to prevent.
 */
export function knownCredentialValues(
  env: NodeJS.ProcessEnv = process.env,
  read: () => Store = () => readStore(),
  opts: { alsoNames?: readonly string[] } = {},
): string[] {
  const values = new Set<string>()
  const add = (raw: string | undefined): void => {
    const value = (raw ?? "").trim()
    if (value.length < 8) return
    // A value with a newline cannot be a pattern in the line-based file below.
    if (value.includes("\n") || value.includes("\0")) return
    values.add(value)
  }
  for (const name of [...CREDENTIAL_ENV_NAMES, ...(opts.alsoNames ?? [])]) add(env[name])
  try {
    for (const stored of Object.values(read())) add(stored?.value)
  } catch {
    /* unreadable store: the boot path reports it; the scan just has fewer values */
  }
  return [...values]
}

/**
 * Which of these files contain one of these values?
 *
 * Byte comparison, not a decoded string: a file the agent wrote can be binary, and a
 * key is ASCII either way. Files over `maxBytes` are skipped rather than loaded — the
 * cap is reported by the caller, not silently obeyed.
 */
export function leakingFiles(
  entries: { path: string; file: string }[],
  values: string[],
  maxBytes = 64 * 1024 * 1024,
): { leaks: string[]; skipped: string[] } {
  const leaks: string[] = []
  const skipped: string[] = []
  if (values.length === 0) return { leaks, skipped }
  const needles = values.map((value) => Buffer.from(value, "utf8"))
  for (const entry of entries) {
    let bytes: Buffer
    try {
      const stat = fs.statSync(entry.file)
      if (!stat.isFile()) continue
      if (stat.size > maxBytes) {
        skipped.push(entry.path)
        continue
      }
      bytes = fs.readFileSync(entry.file)
    } catch {
      continue
    }
    if (needles.some((needle) => bytes.includes(needle))) leaks.push(entry.path)
  }
  return { leaks: leaks.sort(), skipped: skipped.sort() }
}

/**
 * The commits a fetch brought in: reachable from `ref`, not from the host's own HEAD
 * before the fetch. Newest first, capped so the `git grep` argv stays bounded.
 */
export async function fetchedRevs(
  projectDir: string,
  ref: string,
  before: string | null,
  limit = 50,
): Promise<{ revs: string[]; truncated: boolean }> {
  const range = before ? [`${before}..${ref}`] : [ref]
  // One more than the cap, so "there are more" is measured rather than assumed.
  const result = await run("git", ["-C", projectDir, "rev-list", `--max-count=${limit + 1}`, ...range], {
    env: SANITIZED_GIT_ENV,
    allowFailure: true,
  })
  const all = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
  return { revs: all.slice(0, limit), truncated: all.length > limit }
}

/**
 * Parse `rev:path` records from `git grep -l -z` into unique paths.
 *
 * `-z` is why this splits on NUL: without it git quotes a path with a space in it
 * (`"a b.ts"`), and the warning would name a file that does not exist. A newline is
 * tolerated as a delimiter so the parser is testable without a repository.
 */
export function parseGrepPaths(stdout: string): string[] {
  const paths = new Set<string>()
  for (const record of stdout.split(/\0|\n/)) {
    const trimmed = record.trim()
    if (trimmed.length === 0) continue
    const colon = trimmed.indexOf(":")
    if (colon <= 0) continue
    paths.add(trimmed.slice(colon + 1))
  }
  return [...paths]
}

/**
 * Paths in these commits whose content contains one of these values.
 *
 * One `git grep` over every revision, not one per revision: git dedups its work, and
 * the value never appears in argv — it goes through a 0600 patterns file that is
 * removed in `finally`, because argv is readable by every process on the machine.
 */
export async function scanCommittedForCredentials(
  projectDir: string,
  revs: string[],
  values: string[],
): Promise<string[]> {
  if (revs.length === 0 || values.length === 0) return []
  const patterns = path.join(os.tmpdir(), `moat-leak-${process.pid}-${crypto.randomBytes(4).toString("hex")}`)
  fs.writeFileSync(patterns, values.join("\n") + "\n", { mode: 0o600 })
  try {
    const result = await run("git", ["-C", projectDir, "grep", "-l", "-z", "-F", "-f", patterns, ...revs], {
      env: SANITIZED_GIT_ENV,
      allowFailure: true,
    })
    return parseGrepPaths(result.stdout).sort()
  } finally {
    fs.rmSync(patterns, { force: true })
  }
}

/**
 * The one warning both copy-out paths print, so they cannot drift apart.
 *
 * The paths are the agent's: it chose the file names. They go through `stripAnsi`
 * like every other string that came out of the sandbox, or a crafted name would
 * repaint the terminal that is reading the warning.
 */
export function credentialLeakWarning(leaks: string[], carried: string): string {
  return (
    `${leaks.length} file(s) ${carried} contain the credential moat injected into the sandbox:\n` +
    leaks.map((file) => `    ${stripAnsi(file)}`).join("\n") +
    `\n  The agent has to read that value to call the model, and it can write it anywhere. ` +
    "moat names it instead of dropping it: review (or delete) the file before you commit or push, " +
    "and rotate the key if that content has already reached a remote."
  )
}

export function warnAboutCredentialLeak(leaks: string[], carried: string): void {
  log.warn(credentialLeakWarning(leaks, carried))
}

/** A file too large to load is not a file that was searched. Name it. */
export function noteFilesTooLargeToScan(skipped: string[], where: string): void {
  if (skipped.length === 0) return
  log.warn(
    `copy-out: ${where}: ${skipped.length} file(s) are larger than the scan limit and were not searched ` +
      `for the credential: ${skipped.map(stripAnsi).join(", ")}`,
  )
}

/**
 * Say it once when there is nothing to compare against, so silence is not read as
 * approval.
 *
 * A warning, not `log.debug`. It was written as a debug line on the reasoning that it
 * is "just" a note, and debug output was unreachable anyway (`--verbose` was a no-op
 * until Phase 0): the one message that says the leak scan did not run was hidden
 * behind a flag that did nothing. Silence from a scan that never ran is
 * indistinguishable from silence from a scan that found nothing, and only one of
 * those is good news.
 */
export function noteScanSkipped(where: string): void {
  log.warn(
    `copy-out: ${where}: no credential value on this host to compare against, ` +
      `so the files just copied were NOT searched for a leaked key`,
  )
}

/**
 * The variable names this environment's credential was injected under.
 *
 * Read from the environment's state.json rather than guessed from the current
 * process: the credential that went *into the box* is the one the agent could have
 * written into a file, and the boot that minted it may have used
 * `--credential-env NAME`. A state.json from an older moat has no such field, in
 * which case this is empty and the scan falls back to the conventional names.
 */
export function injectedCredentialVarNames(p: { state: string }): string[] {
  const state = readState(p as never)
  const names = state?.credential?.sourceEnvVars
  return Array.isArray(names) ? names.filter((name) => typeof name === "string") : []
}
