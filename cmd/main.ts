#!/usr/bin/env node
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { spawn } from "node:child_process"

import * as log from "../lib/log.ts"
import { hashTree } from "../lib/hash.ts"
import { probeHost, assertHostUsable, describeHost } from "../lib/host.ts"
import { ensureMoatHome, envPaths, validateLogName, type EnvPaths } from "../lib/paths.ts"
import {
  ALPINE_VERSION,
  CODEX_VERSION,
  RUNTIME_BINARY,
  SANDBOX_WORKDIR,
  defaultEgress,
  ownNetns,
  type EgressMode,
} from "../lib/pins.ts"
import { CUSTOM_ENDPOINT, DEEPSEEK, FALLBACK_MODELS, checkBaseUrl, isDeepSeekHost } from "../lib/provider.ts"
import { resolveProvider, type ResolvedProvider } from "../lib/resolve-provider.ts"
import { catalogModel, formatTokens, loadCatalog, type Catalog } from "../lib/catalog.ts"
import { describeProfiles, PROFILE_IDS, resolveProfiles, BASE_PACKAGES, PROFILES, FULL_PROFILE_ID } from "../sandbox/profiles.ts"
import { checkDirectoryIsSane, detectChecks, detectProfiles } from "../lib/detect.ts"
import { runChecks, summarise } from "../sandbox/checks.ts"
import {
  allowHostProblem,
  defaultAllowHosts,
  parseAllowlist,
  runtimeForEgress,
  type EgressRuntime,
} from "../sandbox/egress.ts"
import { run, shellQuote, which } from "../lib/shell.ts"
import { resolveGitDir, sandboxGit } from "../lib/git.ts"
import { recoverStateFromDisk } from "../sandbox/recover.ts"
import { beginBootOrWait, bootAgeSeconds, bootInFlight, endBoot, waitForBoot } from "../sandbox/boot.ts"
import { stripAnsi } from "../lib/terminal.ts"
import { readRootfsFile, readRootfsFileHead, readRootfsFileTail, writeRootfsFile } from "../lib/rootfs-fs.ts"
import {
  credentialExpired,
  envExists,
  initialState,
  listEnvs,
  readState,
  writeState,
  type EnvState,
} from "../sandbox/state.ts"
import {
  baselineSnapshot,
  destroyEnv,
  ensurePackages,
  installRuntimeBinary,
  listSnapshots,
  provisionEnv,
  restoreEnv,
  rootfsSizeBytes,
  snapshotEnv,
} from "../sandbox/rootfs.ts"
import {
  extraSandboxEnv,
  runInSandbox,
  runInteractive,
  sandboxEnv,
  sandboxPidStatus,
  startSandbox,
  stopSandbox,
  stopSlirp,
  READY_MARKER,
  unshareArgs,
  waitForSandboxReady,
  writeInnerScript,
  writeOuterScript,
} from "../sandbox/launcher.ts"
import { renderInstructions } from "../bundle/instructions.ts"
import {
  catalogAllEffortLevels,
  describeCodexTurn,
  installCodexFiles,
  parseCodexEvents,
  renderCodexConfig,
} from "../bundle/codex.ts"
import { computeCost, formatUSD } from "../lib/pricing.ts"
import { runIsolationChecks, type IsolationReport } from "../sandbox/isolation.ts"
import { onboard } from "../secrets/onboard.ts"
import {
  CREDENTIAL_ENV_NAMES,
  DEFAULT_TTL_SECONDS,
  credentialRiskNotice,
  doctorInjectedVarNames,
  mint,
  sandboxProviderEnv,
  scanRootfsForCredential,
  ttlToSeconds,
  toSandboxEnv,
  type MintedCredential,
} from "../secrets/broker.ts"
import { copyIn, ensureSandboxRepo, hostState, isGitRepo, recordBaseline, SANITIZED_GIT_ENV } from "../sync/copyin.ts"
import {
  applyBranch,
  commitSandboxWorktree,
  countUnfetched,
  fetchBranch,
  listSandboxBranches,
  sandboxHeadDetached,
  sandboxWorktreeChanges,
  suggestBranch,
} from "../sync/copyout.ts"
import { applyPlan, describePlan, planApply } from "../sync/apply.ts"
import { COMMAND_FLAGS, SPEC, flag, parse, type Parsed } from "../lib/flags.ts"

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------
// The parser and the flag tables live in lib/flags.ts, so they can be unit-tested
// without a sandbox. parse(argv, SPEC, command) refuses a flag the command does
// not read; main() runs that check before dispatching, and the command parses its
// own arguments again for its own use.

/**
 * A numeric flag that has to be a positive integer.
 *
 * The parser stores `Number(value)` for anything numeric, so `--tail abc` became NaN (which
 * silently means "the whole file") and a boot flag with a typo sailed through provisioning to
 * fail much later, naming something other than the flag. A typo should be a message, not a
 * slow failure.
 */
function optionalPositiveIntFlag(p: Parsed, key: string, max?: number): number | undefined {
  const value = flag<number>(p, key)
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value <= 0 || (max !== undefined && value > max)) {
    log.fail(`--${key} must be a positive integer${max !== undefined ? ` no larger than ${max}` : ""}`)
  }
  return value
}

function positiveIntFlag(p: Parsed, key: string, fallback: number, max?: number): number {
  return optionalPositiveIntFlag(p, key, max) ?? fallback
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function resolveEnv(): EnvPaths {
  return envPaths(process.cwd())
}

/** How long a command waits for another boot of the same environment. */
const BOOT_WAIT_MS = 5 * 60 * 1000

/**
 * Wait out a boot another process is doing, or fail saying so.
 *
 * `down`, `destroy`, `restore` and a second `up` all read state.json, and
 * during a boot it still describes the state *before* it: stopped, no pid. That
 * is what made `moat down` report "sandbox is not running" while a boot was
 * provisioning (the box then came up and stayed up), what let `moat destroy`
 * delete a rootfs out from under one, and what let a second `moat up` boot a
 * second box over the same rootfs -- after which state.json records whichever
 * finished last and the other sandbox is alive with nothing tracking it.
 * Waiting is what the user meant: the boot finishes, then the command acts on
 * the environment that exists.
 */
async function awaitBoot(paths: EnvPaths, doing: string): Promise<void> {
  const record = bootInFlight(paths)
  if (!record || record.pid === process.pid) return
  log.step(
    `${record.command} is already booting this environment (pid ${record.pid}, ${bootAgeSeconds(record)}s in); ` +
      `waiting for it before ${doing}`
  )
  const outcome = await waitForBoot(paths, { timeoutMs: BOOT_WAIT_MS })
  if (outcome === "timeout") {
    log.fail(
      `a boot is still in progress (pid ${record.pid}, ${bootAgeSeconds(record)}s in), so ${doing} would race it.\n` +
        "  wait for `moat up` to finish, or interrupt it (ctrl-c) and run this again.",
    )
  }
  log.info("the boot finished")
}

function requireState(p: EnvPaths): EnvState {
  const state = readState(p)
  if (!state) log.fail(`no moat environment for ${p.projectDir}. Run \`moat up\` first.`)
  return state
}

/**
 * Is the sandbox recorded in state actually alive *and* ours?
 *
 * `isRunning` only proves that some process has that pid. `sandboxPidStatus`
 * matches the recorded start time (or, for older environments, the environment
 * id in the command line), so a reused pid is reported as stale instead of
 * signalled.
 */
function sandboxAlive(state: EnvState, paths: EnvPaths): boolean {
  return sandboxPidStatus(state.pid, { startTime: state.pidStart, envId: paths.id }) === "ours"
}

/**
 * Stop the datapath recorded for an environment whose box is not running.
 *
 * slirp4netns is its own process, so a box that dies out of band — killed, OOM, host
 * reboot — leaves it running, and only a command that still holds its pid on record can
 * stop it. `moat up` reaps one before it overwrites state.json; `down`, `restore` and
 * `destroy` are about to forget or delete that record, so they reap first. Otherwise the
 * process outlives every command that could attribute it, and `moat destroy --all` — the
 * documented way to reclaim what moat holds — cannot see it.
 *
 * `stopSlirp` matches the recorded start time, so a pid the host handed to something else
 * is left alone, and it returns true only when there was a live datapath to signal: the
 * warning is printed on that answer, never on the attempt.
 */
async function reapRecordedDatapath(state: Pick<EnvState, "slirpPid" | "slirpStart"> | null): Promise<boolean> {
  if (!state?.slirpPid) return false
  const reaped = await stopSlirp(state.slirpPid, state.slirpStart ?? null)
  if (reaped) log.warn(`reaped the datapath of a sandbox that is no longer running (pid ${state.slirpPid})`)
  return reaped
}

/**
 * Mark an environment stopped: reap its datapath, then clear the record.
 *
 * This is the only place `cmd/main.ts` clears the *datapath* record from state.json.
 * Every branch that ends a box goes through it — the ones that stopped the box, and the
 * ones that found it already gone, whose only remaining hold on the datapath is the
 * record itself. (A branch that drops the box pid but keeps the datapath record, like
 * `requireRunning`, is the other safe shape: the process is still attributable.) Both
 * parts here are easy to do in the wrong order and impossible to notice afterwards: the
 * process keeps running and nothing on disk names it any more.
 *
 * `test/unit/datapath-reap.test.ts` holds the shape: a direct `slirpPid: null` write
 * outside this function is the bug coming back.
 */
async function forgetBox(paths: EnvPaths, state: EnvState): Promise<EnvState> {
  await reapRecordedDatapath(state)
  const stopped: EnvState = {
    ...state,
    status: "stopped",
    pid: null,
    pidStart: null,
    slirpPid: null,
    slirpStart: null,
  }
  writeState(paths, stopped)
  return stopped
}

/** Where to prove an allowlisted endpoint is still reachable, for the doctor. */
function providerProbe(baseUrl: string): { host: string; port: number } | undefined {
  try {
    const url = new URL(baseUrl)
    if (!url.hostname) return undefined
    return { host: url.hostname, port: Number(url.port) || (url.protocol === "https:" ? 443 : 80) }
  } catch {
    return undefined
  }
}

/** The provider host an allowlist must include, from the recorded base URL. */
function providerHost(baseUrl: string | null | undefined): string | undefined {
  if (!baseUrl) return undefined
  try {
    return new URL(baseUrl).hostname || undefined
  } catch {
    return undefined
  }
}

/**
 * The datapath and (for filtered egress) the ruleset a fresh boot needs.
 *
 * An own-namespace environment resolves the pinned slirp4netns binary here, once,
 * so every ephemeral boot (doctor, exec, checks) runs in the same kind of network
 * as the long-running box rather than quietly measuring a different one. The
 * allowlist is the default registry/provider set plus whatever the user added,
 * and resolution happens here on the host, on every boot, so rotated addresses
 * are picked up.
 */
/**
 * A filtered boot loads its rules with `nft` from inside the box, so the binary
 * has to be there. The image carries it, but an environment restored from a
 * snapshot taken before it did — or one whose agent ran `apk del nftables` —
 * would fail *every* boot with "[moat] failed to apply the egress policy", which
 * reads like a moat bug rather than a missing package. Every path that boots a
 * filtered box goes through here, not just `moat up`.
 */
async function ensureFilterTool(paths: EnvPaths): Promise<void> {
  const binary = path.join(paths.rootfs, "usr/sbin/nft")
  if (fs.existsSync(binary)) return
  log.step("installing nftables for filtered egress")
  await ensurePackages(paths, ["nftables"], { post: [], onOutput: (chunk) => log.debug(chunk.trimEnd()) })
  if (fs.existsSync(binary)) return
  // The database can say "installed" while the file is gone — the agent can
  // delete it without touching apk's records, and then `apk add` has nothing to
  // do. Clear the stale entry and install again.
  log.step("repairing the nftables install (its files were removed, its package entry was not)")
  await ensurePackages(paths, ["nftables"], {
    post: [],
    resetFirst: true,
    onOutput: (chunk) => log.debug(chunk.trimEnd()),
  })
  if (!fs.existsSync(binary)) log.fail("nftables could not be installed, so this environment cannot boot filtered")
}

/**
 * Say what the allowlist could not resolve.
 *
 * A host the host resolver cannot reach is dropped from the ruleset, and a box
 * that boots anyway looks fine until the agent calls the model. The provider is
 * fatal for a filtered boot; anything else is a warning, because the box still
 * works without an extra registry.
 */
function reportUnresolved(
  unresolved: string[] | undefined,
  required: string | undefined,
  fatal: boolean,
): void {
  if (!unresolved || unresolved.length === 0) return
  const missingRequired = required !== undefined && unresolved.includes(required)
  if (missingRequired) {
    const message =
      `could not resolve ${required}, so a filtered sandbox would not reach the model. ` +
      "Check DNS and try again, or pass --egress open to boot without the allowlist."
    if (fatal) log.fail(message)
    else log.warn(message)
  }
  const others = unresolved.filter((host) => host !== required)
  if (others.length > 0) {
    log.warn(`the egress allowlist could not resolve: ${others.join(", ")}; the box will not reach them`)
  }
}

async function egressRuntime(state: EnvState, paths: EnvPaths): Promise<EgressRuntime> {
  if (state.egress === "filtered") await ensureFilterTool(paths)
  const provider = providerHost(state.providerBaseUrl ?? DEEPSEEK.baseUrl)
  const hosts = [...defaultAllowHosts(provider), ...(state.egressAllow ?? [])]
  const runtime = await runtimeForEgress(state.egress, { rootfs: paths.rootfs, allowHosts: hosts })
  // Ephemeral boots warn rather than fail: `moat exec` may be exactly how the
  // user is diagnosing the box, and doctor's own check reports it as a failure.
  reportUnresolved(runtime.unresolved, provider, false)
  return runtime
}

function human(bytes: number): string {
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  if (bytes > 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value}ms`
}

// ---------------------------------------------------------------------------
// provider, model and profile resolution
// ---------------------------------------------------------------------------

// Provider resolution lives in lib/resolve-provider.ts, where it can be unit tested
// without a CLI: it is the decision that remembered too little (an environment's own
// endpoint) and silently reverted it on the next boot.
type ResolvedModel = {
  providerID: string
  modelID: string
  model: string
  native: boolean
  /** Every model id the provider defines, for declaring per-model config. */
  modelIDs: string[]
  meta: { context?: number; output?: number; toolCall?: boolean; reasoning?: boolean; attachment?: boolean } | undefined
}

async function resolveModel(provider: ResolvedProvider, catalog: Catalog | null): Promise<ResolvedModel> {
  const modelID = provider.modelID
  const known = catalogModel(catalog, provider.id, modelID)

  // A native model id that the catalog does not describe would leave opencode
  // unable to resolve it, so say so and describe it here instead.
  const catalogProvider = catalog?.get(provider.id)
  if (catalog && provider.native && catalogProvider && !known) {
    log.warn(
      `${provider.id} does not define "${modelID}" in the models.dev catalog; declaring it as a custom ` +
        `model instead. Known ids: ${catalogProvider.models.map((m) => m.id).join(", ")}   (moat models)`,
    )
  }
  if (known && known.toolCall === false) {
    log.warn(`${provider.id}/${modelID} does not advertise tool calling; the agent will not be able to act.`)
  }

  const useNative = provider.native && (known !== null || !catalog)
  const providerID = useNative ? provider.id : CUSTOM_ENDPOINT.id
  return {
    providerID,
    modelID,
    model: `${providerID}/${modelID}`,
    native: useNative,
    /**
     * Every model id this provider defines, so the bundle can declare its
     * variants for all of them and not just the one being booted. `/model`
     * switches between them at runtime, and a variant declared only for the
     * boot model would silently disappear after a switch.
     *
     * The chosen model is always included: for a custom endpoint there is no
     * catalog entry to enumerate, and for a native model the catalog may not
     * know the id the user asked for.
     */
    modelIDs: [...new Set([modelID, ...(catalogProvider?.models.map((m) => m.id) ?? [])])],
    meta: known
      ? {
          context: known.context,
          output: known.output,
          toolCall: known.toolCall,
          reasoning: known.reasoning,
          attachment: known.attachment,
        }
      : undefined,
  }
}

/** The branch the agent works on, so the user's own branch is untouched even inside the box. */
function sessionBranch(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")
  // No slash: the copy-out ref is `refs/moat/<branch>`, and a slash here would
  // produce `refs/moat/moat/session-…`.
  return `moat-session-${stamp}`
}

// ---------------------------------------------------------------------------
// moat up
// ---------------------------------------------------------------------------

async function cmdUp(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const started = Date.now()
  const host = await assertHostUsable()
  const paths = resolveEnv()

  // Another boot of this environment may already be provisioning it. Two at once
  // race over one rootfs, and state.json ends up describing whichever finished
  // last, leaving the other sandbox alive and untracked. The wait and the claim
  // are one call because doing them separately leaves a window: this used to wait
  // here and only record its own marker after provisioning had begun, so two `up`s
  // could both pass the check before either wrote, and both provision.
  const bootCommand = p._.join(" ").trim().length > 0 ? "moat up (with a task)" : "moat up"
  try {
    await beginBootOrWait(paths, bootCommand, {
      onWait: (record) =>
        log.step(`waiting for ${record.command} (pid ${record.pid}, ${bootAgeSeconds(record)}s in) to finish`),
    })
  } catch (error) {
    log.fail((error as Error).message)
  }

  const json = flag<boolean>(p, "json") ?? false
  const report: Record<string, unknown> = { project: paths.projectDir, envId: paths.id }

  let state = readState(paths)
  // Read the task once, before anything can return early. A task given to a
  // running sandbox used to be dropped on the floor by the reuse path below.
  const task = p._.join(" ").trim()

  // Whether a human is actually attached. This decides two things that must
  // agree: whether the agent may ask a question, and what its instructions say
  // about asking. Getting them out of step is how you get a hang.
  const interactive = process.stdin.isTTY === true && !json && !flag<boolean>(p, "no-follow")

  const fresh = flag<boolean>(p, "fresh") ?? false
  const sync = flag<boolean>(p, "sync") ?? false
  // --timeout is seconds everywhere. Validating it here means a typo fails before
  // provisioning rather than after the boot.
  optionalPositiveIntFlag(p, "timeout")
  // --effort is validated against the levels the vendored catalog declares (low/high/max for
  // DeepSeek), before provisioning: a level Codex would silently drop is the bug class this
  // project keeps finding, and the catalog is the only honest source for the list.
  const effortFlag = flag<string>(p, "effort")
  if (effortFlag !== undefined && !catalogAllEffortLevels().includes(effortFlag)) {
    log.fail(`unknown --effort "${effortFlag}". DeepSeek catalog declares: ${catalogAllEffortLevels().join(", ")}`)
  }
  // --credential-ttl is parsed with the same function that will parse it at mint time, for the
  // same reason: measured before this, a typo ran the whole copy-in and then failed.
  try {
    ttlToSeconds(flag<string>(p, "credential-ttl") ?? process.env.MOAT_CREDENTIAL_TTL ?? `${DEFAULT_TTL_SECONDS}s`)
  } catch (error) {
    log.fail(`--credential-ttl: ${(error as Error).message}`)
  }
  const modelFlag = flag<string>(p, "model")
  if (modelFlag !== undefined && modelFlag.trim().length === 0) log.fail("--model needs a model id")
  for (const key of ["base-url", "upstream"] as const) {
    const value = flag<string>(p, key)
    if (value === undefined) continue
    // Not just "does it parse": a scheme-less `localhost:11434/v1` parses with an
    // empty hostname, and a filtered box with no provider address boots happily and
    // fails only when the agent calls the model (lib/provider.ts has the measurement).
    const problem = checkBaseUrl(key, value)
    if (problem) log.fail(problem)
  }
  // state.json is metadata; the environment is the rootfs. A missing or
  // unreadable state used to read as "no environment", and the provisioning
  // below then replaced the rootfs: measured, deleting state.json and booting
  // again destroyed a committed agent branch and an untracked file without a
  // word, which also contradicts SPEC §2.2 ("moat destroy is the only
  // operation that deletes data"). The sandbox repository is the evidence that
  // there is something to keep, and it can only exist after provisioning *and*
  // copy-in have both finished, so its presence also rules out adopting a
  // rootfs that was interrupted halfway through being built.
  if (!state && !fresh && envExists(paths) && fs.existsSync(path.join(paths.work, ".git"))) {
    if (fs.existsSync(paths.state)) {
      // Unreadable rather than absent: keep it for whoever has to work out why.
      const salvage = `${paths.state}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`
      fs.renameSync(paths.state, salvage)
      log.warn(`state.json could not be read; kept it as ${salvage}`)
    }
    state = await recoverStateFromDisk(paths)
    writeState(paths, state)
    report.recovered = true
    log.warn(
      "state.json is missing, but the sandbox's working tree is still there, so the environment was " +
        "recovered from disk instead of replaced.\n" +
        `  branch   ${state.branch ?? "(detached head)"}\n` +
        `  baseline ${state.baselineCommit ? state.baselineCommit.slice(0, 12) : "(not recorded)"}\n` +
        "  everything installed in it, and every commit it holds, are intact; this boot mints a fresh credential.\n" +
        "  the host-drift check cannot run without the recorded baseline: `moat up --sync` re-copies the " +
        "project and restores it.\n" +
        "  to discard the sandbox's copy instead: moat up --fresh --yes",
    )
  }
  // The binary can be missing: the agent can delete it, and an environment provisioned by an
  // older moat never had it. It is put back into the live rootfs below, not by re-provisioning
  // — provisioning deletes the rootfs first and would take the agent's work with it.
  const runtimePresent = fs.existsSync(path.join(paths.rootfs, RUNTIME_BINARY))
  const needsProvision = fresh || !envExists(paths) || !state

  // Where the provider lives decides the default network policy, so resolve it
  // first; nothing below this point changes it.
  let provider: ResolvedProvider
  try {
    provider = resolveProvider(p, state)
  } catch (error) {
    log.fail((error as Error).message)
  }

  // Network policy is part of the environment's identity: it is persisted, and a
  // change means the box has to be booted again in different namespaces.
  const egressFlag = flag<string>(p, "egress")
  const egressCandidate = egressFlag ?? state?.egress ?? defaultEgress(provider.baseUrl)
  if (egressCandidate !== "open" && egressCandidate !== "isolated" && egressCandidate !== "filtered") {
    log.fail(
      `unknown --egress "${egressCandidate}". Use "open" (the host's network namespace), "isolated" ` +
        `(its own, through slirp4netns) or "filtered" (isolated, with a default-deny allowlist).`,
    )
  }
  const egress: EgressMode = egressCandidate
  if (egressFlag === undefined && !state?.egress && egress === "open") {
    log.info(
      `egress: open, because the provider is on the host's loopback (${provider.baseUrl}) and the sandbox's ` +
        "own namespace cannot reach it. Pass --egress filtered to filter it anyway.",
    )
  }
  // The allowlist is per environment: an empty flag keeps what is recorded.
  const allowFlag = flag<string>(p, "egress-allow")
  const egressAllow = allowFlag !== undefined ? parseAllowlist(allowFlag) : (state?.egressAllow ?? [])
  if (allowFlag !== undefined) {
    // An entry the resolver will drop is worse than a rejected one: the boot
    // succeeds, the box looks filtered, and the thing the user allowed is
    // unreachable with no explanation anywhere.
    for (const host of egressAllow) {
      const problem = allowHostProblem(host)
      if (problem) log.fail(`--egress-allow ${host}: ${problem}`)
    }
  }
  if (egressAllow.length > 0 && egress !== "filtered") {
    log.info(
      `egress: ${egressAllow.length} allowlist host(s) are recorded, but they only apply to filtered egress; ` +
        `this environment is ${egress}.`,
    )
  }

  // `moat` on its own is typed anywhere, so the obvious wrong directories are
  // caught before a byte is copied. This runs before provisioning, because
  // discovering the mistake after unpacking a rootfs is a waste of a minute.
  const warning = checkDirectoryIsSane(paths.projectDir)
  if (warning && !flag<boolean>(p, "force")) {
    log.fail(
      `refusing to sandbox ${warning.detail}: ${warning.reason}.\n` +
        "  moat copies the whole directory into the sandbox, so this is almost never what you want.\n" +
        "  cd into the project you meant, or pass --force if you really do.",
    )
  }

  // `--fresh` rebuilds the rootfs, and the rootfs contains /work: the agent's
  // branch and any uncommitted work. That is destructive, so it is gated twice:
  // never while a sandbox is live, and never without --yes when the box holds
  // work the host cannot reach. Before this, --fresh deleted /work and forgot a
  // running sandbox's pid, orphaning it, without saying a word.
  if (fresh && envExists(paths)) {
    if (state && sandboxAlive(state, paths)) {
      log.fail(
        `a sandbox for this project is still running (pid ${state.pid}).\n` +
          "  run \`moat down\` first: --fresh replaces the rootfs it is using.",
      )
    }
    if (!flag<boolean>(p, "yes") && resolveGitDir(paths.work)) {
      const unfetched = await countUnfetched(paths)
      const dirty = await sandboxWorktreeChanges(paths)
      if (unfetched > 0 || dirty.length > 0) {
        log.fail(
          "--fresh deletes the sandbox's working tree, and it holds work the host cannot reach:\n" +
            `  ${unfetched} commit(s) not fetched, ${dirty.length} uncommitted file(s)\n` +
            "  fetch it first with \`moat fetch\`, or pass --yes to delete it.",
        )
      }
    }
  }

  let profileRequest = (flag<string>(p, "profile") ?? process.env.MOAT_PROFILES ?? "").trim()
  // A debug line on the path every boot takes, whether or not it auto-detects: it is
  // what makes `--verbose` observable end to end. Every other `log.debug` site is
  // conditional (a cache hit, an untracked-file count, a merge), so `--verbose` could
  // print nothing at all on an ordinary boot, and "the flag works" is exactly the
  // claim that has to be checkable from outside the process.
  log.debug(
    `profiles: requested=${profileRequest || "(none)"} recorded=${state?.profiles?.length ? state.profiles.join(",") : "(none)"} ` +
      `detect=${flag<boolean>(p, "no-detect") ? "off" : "on"}`,
  )
  if (!profileRequest && !state?.profiles?.length && !flag<boolean>(p, "no-detect")) {
    const detected = detectProfiles(paths.projectDir)
    if (detected.profiles.length > 0) {
      profileRequest = detected.profiles.join(",")
      log.info(`detected: ${detected.reasons.join(", ")}`)
      log.info(`          adding profile(s) ${detected.profiles.join(", ")}; use --no-detect or --profile to override`)
    } else if (detected.uncertain) {
      log.info("no project manifest found; booting with the base image only (see `moat profiles`)")
    }
  }
  const resolvedProfiles = resolveProfiles(profileRequest ? [profileRequest] : [])
  if (resolvedProfiles.unknown.length > 0) {
    log.fail(`unknown --profile: ${resolvedProfiles.unknown.join(", ")}.\n\n${describeProfiles()}`)
  }

  // The boot marker was claimed at the top of this command, in the same atomic step
  // as the wait (see `beginBootOrWait`). It stays until the readiness wait at the
  // end of the boot, and is what lets `down`, `destroy`, `restore` and a second `up`
  // see a boot in progress instead of reading state.json and concluding nothing is
  // happening.

  if (needsProvision) {
    log.step(
      `provisioning sandbox image (alpine ${ALPINE_VERSION} + codex ${CODEX_VERSION}` +
        `${resolvedProfiles.profiles.length > 0 ? ` + ${resolvedProfiles.profiles.join(", ")}` : ""})`,
    )
    const provision = await provisionEnv(paths, { useImageCache: !fresh, packages: resolvedProfiles.packages })
    report.provisionMs = provision.totalMs
    report.provisionFromImageCache = provision.fromImageCache
    report.imageCache = provision.imageCache
    report.provisionSteps = provision.steps
    // The cached image *is* the baseline. Linking to it instead of compressing a
    // second 107 MiB copy is worth several seconds on every cold start.
    const baseline = baselineSnapshot(paths, provision)
    report.baselineSnapshot = { name: "baseline", bytes: baseline.bytes, linked: baseline.linked }
    state = initialState(paths, { alpine: ALPINE_VERSION })
    writeState(paths, state)
    log.success(`image provisioned in ${ms(provision.totalMs)} (${provision.steps.map((s) => `${s.name} ${ms(s.ms)}`).join(", ")})`)
  }

  // A binary the agent deleted, or a rootfs provisioned before moat installed one, is put
  // back here rather than by re-provisioning: provisioning deletes the rootfs first and would
  // take /work with it, and a copy into /usr/local/bin touches nothing the agent owns.
  if (!needsProvision && !runtimePresent) {
    log.step("installing the codex runtime into this environment")
    await installRuntimeBinary(paths)
  }

  // The recorded pid is only meaningful if it is still the process moat started.
  if (state!.pid && !sandboxAlive(state!, paths)) {
    log.warn(`the recorded sandbox pid ${state!.pid} is not moat's any more; ignoring it`)
    state = { ...state!, status: "stopped", pid: null, pidStart: null }
    writeState(paths, state)
  }

  // An expired credential means the watchdog has already stopped the agent.
  // Reusing the pid would hand back a box that cannot serve a turn, so stop it
  // and fall through to a fresh boot, which mints a new credential.
  if (state!.pid && sandboxAlive(state!, paths) && credentialExpired(state!)) {
    log.warn("the injected credential for this sandbox has expired; restarting it to mint a fresh one")
    await stopSandbox(state!.pid!, {
      startTime: state!.pidStart,
      envId: paths.id,
      slirpPid: state!.slirpPid,
      slirpStart: state!.slirpStart,
    })
    state = await forgetBox(paths, state!)
  }

  // Changing egress mode changes the namespaces the sandbox runs in, so the box
  // is restarted rather than reused under a policy it was not booted with.
  const allowChanged =
    JSON.stringify([...egressAllow].sort()) !== JSON.stringify([...(state!.egressAllow ?? [])].sort())
  if (state!.pid && sandboxAlive(state!, paths) && (state!.egress !== egress || allowChanged)) {
    log.warn(
      state!.egress !== egress
        ? `egress mode changed (${state!.egress} -> ${egress}); restarting the sandbox`
        : "the egress allowlist changed; restarting the sandbox to apply it",
    )
    await stopSandbox(state!.pid!, {
      startTime: state!.pidStart,
      envId: paths.id,
      slirpPid: state!.slirpPid,
      slirpStart: state!.slirpStart,
    })
    state = await forgetBox(paths, state!)
  }

  // A keepalive box that is still alive *is* the environment being up: `moat up` with nothing
  // else to do is finished. Work is different. A task and the TUI each run in their own
  // ephemeral boot of this rootfs, and both need the credential resolved at boot time, which
  // this box may have outlived — so they stop it and take the boot path below.
  if (state!.pid && sandboxAlive(state!, paths)) {
    if (task.length === 0 && !interactive) {
      if (json) log.emit({ ...report, status: "already-running", ...state })
      else printUpSummary(paths, state!, { coldStart: 0, reused: true, provisioned: false })
      return 0
    }
    log.info(`sandbox already running (pid ${state!.pid}); restarting it for this run`)
    await stopSandbox(state!.pid, {
      startTime: state!.pidStart,
      envId: paths.id,
      slirpPid: state!.slirpPid,
      slirpStart: state!.slirpStart,
    })
    state = await forgetBox(paths, state!)
  }

  // Profiles are additive: adding one to an existing environment installs only
  // what is missing, and it persists in the rootfs afterwards.
  if (!needsProvision && resolvedProfiles.packages.length > 0) {
    const before = Date.now()
    const result = await ensurePackages(paths, resolvedProfiles.packages, {
      post: resolvedProfiles.post,
      onOutput: (chunk) => log.debug(chunk.trimEnd()),
    })
    const installed = result.installed
    report.profileInstall =
      installed.length > 0 ? { installed, ms: Date.now() - before } : { installed: [], ms: Date.now() - before }
    if (installed.length > 0) {
      log.success(`installed ${installed.length} package(s) for profile(s) ${resolvedProfiles.profiles.join(", ")}`)
      for (const command of resolvedProfiles.post) {
        const check = await runInSandbox(paths, `#!/bin/sh
set -u
${command}
`)
        if (check.code !== 0) log.warn(`profile setup step failed: ${command}`)
      }
    } else {
      log.info("profiles: everything requested is already installed")
    }
  }

  const copyInStart = Date.now()
  const sandboxRepoExists = fs.existsSync(path.join(paths.work, ".git"))

  // Has the host project moved on since it was copied in? Running an agent
  // against a stale copy is a silent, expensive failure, so this is checked on
  // every boot rather than left to the user to remember --sync.
  let drift: { changed: boolean; sandboxCommits: number; sandboxFiles: number } | null = null
  if (!needsProvision && sandboxRepoExists && !sync && state && !state.baselineHostState) {
    // A recovered environment: the baseline went missing with the rest of
    // state.json, and without it there is no way to tell whether the host
    // moved on since the copy. Silence here would let the agent work on a
    // stale tree, which is the exact failure this check exists for.
    log.warn(
      "this environment was recovered without its recorded baseline, so the host-drift check cannot run; " +
        "`moat up --sync` re-copies the project and restores it",
    )
  } else if (!needsProvision && sandboxRepoExists && !sync && state?.baselineHostState) {
    const current = await hostState(paths.projectDir)
    if (current !== state.baselineHostState) {
      drift = {
        changed: true,
        sandboxCommits: await countUnfetched(paths),
        // Uncommitted sandbox work counts as work to lose: copy-in wipes the
        // working tree, and no fetch could have preserved it.
        sandboxFiles: (await sandboxWorktreeChanges(paths)).length,
      }
    }
  }
  const safeToRecopy = drift?.changed === true && drift.sandboxCommits === 0 && drift.sandboxFiles === 0
  const mustCopy = needsProvision || sync || !sandboxRepoExists || safeToRecopy

  // Say what a copy would discard, and take it from the *count*, not from the
  // decision that was made with it. A copy happens when the host changed and nothing
  // is held (the automatic case), when the user asked with --sync, or when there is
  // no repository yet; the warning has to follow the count either way, or it can
  // promise safety it never checked. Measured: this said "the sandbox holds nothing
  // that is not already on the host" while destroying a commit on a side branch — and
  // the --sync-only variant of the warning missed the same commit entirely.
  const heldParts: string[] = []
  if (drift) {
    if (drift.sandboxCommits > 0) heldParts.push(`${drift.sandboxCommits} commit(s)`)
    if (drift.sandboxFiles > 0) heldParts.push(`${drift.sandboxFiles} uncommitted file(s)`)
  } else if (mustCopy && sandboxRepoExists) {
    const commits = await countUnfetched(paths)
    const files = (await sandboxWorktreeChanges(paths)).length
    if (commits > 0) heldParts.push(`${commits} commit(s)`)
    if (files > 0) heldParts.push(`${files} uncommitted file(s)`)
  }
  const held = heldParts.join(" and ")

  // A detached HEAD is work `moat fetch` cannot read, so the warning has to name the way
  // out: sending the user to a command that cannot collect it would be a lie of omission.
  const detachedHint =
    held.length > 0 && (await sandboxHeadDetached(paths))
      ? "\n  the sandbox is on a detached HEAD, and `moat fetch` reads branches. Name the work first:\n" +
        "  moat exec -- git -C /work branch keep && moat fetch keep"
      : ""

  if (mustCopy && held) {
    log.warn(
      `re-copying the project will discard ${held} that exist only inside the sandbox: the sandbox working tree ` +
        `is replaced from the host. \`moat fetch\` (add --commit-worktree for uncommitted work) keeps it.${detachedHint}`,
    )
  } else if (drift?.changed && mustCopy) {
    log.warn(
      "the host project has changed since it was copied in, and the sandbox holds nothing that is not already " +
        "on the host. Re-copying it now.",
    )
  } else if (drift?.changed) {
    log.warn(
      `the host project has changed since it was copied in, but the sandbox holds ${held} that the host does not ` +
        `have. The agent will work on the OLD copy. Run \`moat fetch\` (add --commit-worktree to include ` +
        `uncommitted work) to keep it, or \`moat up --sync\` to discard it and re-copy.${detachedHint}`,
    )
  }

  if (mustCopy) {
    const copied = await copyIn(paths)
    await ensureSandboxRepo(paths)
    const baselineCommit = await recordBaseline(paths)
    if (baselineCommit) log.debug(`baseline recorded at ${baselineCommit.slice(0, 12)}`)
    // The agent branch is cut AFTER the baseline, so the baseline is always the
    // common ancestor for a three-way merge.
    state!.baselineCommit = baselineCommit
    state!.baselineDigest = copied.digest
    state!.baselineHostState = copied.hostState
    report.copyIn = copied
    log.success(
      `copy-in via ${copied.transport}: ${copied.files} files, ${human(copied.bytes)}, ` +
        `digest ${copied.digest.slice(0, 16)}${copied.dirty ? ` (dirty tree: ${copied.trackedChanges} modified, ${copied.untrackedFiles} untracked)` : ""}`,
    )
    if (copied.suspectSecrets.length > 0) {
      log.warn(
        `copied in ${copied.suspectSecrets.length} file(s) that look like they hold credentials: ` +
          `${copied.suspectSecrets.join(", ")}. The agent can read these and the network is open ` +
          `(docs/SPEC.md §7.5). Delete them from the project, or accept that they are in the box.`,
      )
    }
  } else {
    log.info("copy-in: reusing the sandbox working tree (use --sync to re-copy from the host)")
  }
  report.copyInMs = Date.now() - copyInStart

  // --- provider, model, catalog ---------------------------------------------
  const catalog = flag<boolean>(p, "refresh") ? await loadCatalog({ refresh: true }) : await loadCatalog()
  const baseUrl = provider.baseUrl
  const resolvedModel = await resolveModel(provider, catalog)
  report.provider = { id: resolvedModel.providerID, native: resolvedModel.native, label: provider.label }
  report.model = {
    id: resolvedModel.model,
    context: resolvedModel.meta?.context,
    output: resolvedModel.meta?.output,
    toolCall: resolvedModel.meta?.toolCall,
  }
  if (resolvedModel.meta?.context) {
    log.info(
      `model: ${resolvedModel.model} (context ${formatTokens(resolvedModel.meta.context)}` +
        `${resolvedModel.meta.output ? `, out ${formatTokens(resolvedModel.meta.output)}` : ""})`,
    )
  } else {
    log.info(`model: ${resolvedModel.model}`)
  }

  // --- credential -----------------------------------------------------------
  const ttlText =
    flag<string>(p, "credential-ttl") ?? process.env.MOAT_CREDENTIAL_TTL ?? `${DEFAULT_TTL_SECONDS}s`
  const ttlSeconds = ttlToSeconds(ttlText)
  let credential: MintedCredential | null = null
  // A custom endpoint may need no credential at all, and the box can reach it with no
  // Authorization header (measured: five tool calls, six requests, no auth header). The
  // native provider cannot: without the key there is no model. Say which case this is
  // instead of one message for both.
  const noCredentialNotice = resolvedModel.native
    ? `no ${DEEPSEEK.envVar}, so the agent has no model to call.\n` +
      `  export ${DEEPSEEK.envVar}=sk-...   then run moat again\n` +
      "  or pass --credential-env NAME if it lives under a different name"
    : `no credential injected, so requests to ${baseUrl} will carry no Authorization header. ` +
      "If that endpoint needs one, pass --credential-env NAME (or --credential VALUE)."
  // The value is on the host command line when it is passed this way: every local user reads
  // argv through ps, and the shell keeps it in history. Say so where it is passed, not only in
  // the risk notice after the fact.
  if (flag<string>(p, "credential") !== undefined) {
    log.warn(
      "--credential puts the key in this process's argv, where every local user can read it " +
        "(and your shell has it in history). Prefer --credential-env NAME, or the credential " +
        "store that moat fills in on first run.",
    )
  }
  if (!flag<boolean>(p, "no-credential")) {
    credential = mint({
      literal: flag<string>(p, "credential"),
      envName: flag<string>(p, "credential-env"),
      // The provider *id*, not its label: this is the key the credential store
      // is indexed by, and what `onboard` writes.
      provider: provider.id,
      baseUrl,
      model: resolvedModel.modelID,
      ttlSeconds,
      // DeepSeek gets the key under the name its API and Codex's env_key use. A custom
      // endpoint gets it under moat's own name, which the rendered provider
      // block references as {env:MOAT_INJECTED_CREDENTIAL}.
      targetEnvVars: resolvedModel.native ? [DEEPSEEK.envVar] : [],
    })
    if (!credential && interactive) {
      // At a terminal, do not explain what is missing: ask for it. The key is
      // checked against the provider before being saved, so a typo cannot turn
      // into a confusing failure several steps later.
      const key = await onboard()
      if (key) {
        credential = mint({
          provider: provider.id,
          baseUrl,
          model: resolvedModel.modelID,
          ttlSeconds,
          targetEnvVars: resolvedModel.native ? [DEEPSEEK.envVar] : [],
        })
      }
    }

    if (!credential) {
      log.warn(noCredentialNotice)
    } else {
      log.warn(credentialRiskNotice(credential, egress))
    }
  } else if (!resolvedModel.native) {
    // --no-credential is deliberate and silent for the native provider (there is no key,
    // and the user asked for that). A custom endpoint still deserves the note, because
    // "no Authorization header" is a property of the requests, not a missing key — and
    // this is the mode SPEC §1.3 recommends for a box with nothing stealable in it.
    log.warn(noCredentialNotice)
  }

  // --- branch, bundle -------------------------------------------------------
  // Work on a dedicated branch so the user's own branch is untouched inside the
  // box too, and copy-out has one predictable ref to read.
  const branch = sessionBranch()
  let baseBranch: string | null = null
  if (fs.existsSync(path.join(paths.work, ".git"))) {
    // The sandbox repository is agent-controlled: its config, hooks and
    // attributes are neutralized for the duration of every host-side git call.
    baseBranch = (await sandboxGit(paths.work, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true })).stdout.trim() || null
    const created = await sandboxGit(paths.work, ["checkout", "-q", "-B", branch], { allowFailure: true })
    if (created.code === 0) log.info(`agent branch: ${branch}`)
    else log.warn(`could not create ${branch} inside the sandbox; the agent will use the current branch`)
  }

  // The bundle is rendered and reinstalled on EVERY boot. The rootfs may have
  // come from the host image cache or from an environment created days ago,
  // either of which would otherwise keep running a stale plugin, which is
  // exactly how a shell.env fix silently failed to take effect once already.
  const projectChecks = detectChecks(paths.projectDir)
  if (projectChecks.length > 0) {
    log.info(`checks: ${projectChecks.map((c) => c.command).join(", ")}`)
  }

  // The boot the agent is told about is rendered from this, and it is the same object the
  // config and the brief below are written from: an input that is declared but never read is
  // how the brief came to describe a boot that was not the one being made.
  const briefInput = {
    provider: provider.label,
    model: resolvedModel.model,
    branch,
    profiles: resolvedProfiles.profiles,
    installedPackages: resolvedProfiles.profiles.length > 0 ? resolvedProfiles.packages : BASE_PACKAGES,
    hasCredential: Boolean(credential),
    canAsk: interactive,
    egress,
    checks: projectChecks.map((c) => ({ label: c.label, command: c.command })),
  }
  // Fail before booting, not after. Asking for a task with no model means the
  // box starts, the turn errors immediately, and the user is left reading a
  // session id. Cheaper to say so now — but only for the native provider, where the
  // key *is* the model. A custom endpoint can work with no credential at all
  // (measured against a local stub: five tool calls, six requests, no auth header),
  // and this guard used to refuse the very path its own message recommended.
  if (task.length > 0 && !credential && resolvedModel.native) {
    log.fail(
      `no ${DEEPSEEK.envVar}, so the agent has no model to call.\n` +
        `  export ${DEEPSEEK.envVar}=sk-...   then run it again\n` +
        "  or run `moat` with no arguments at a terminal and it will ask for the key\n" +
        "  or point at another OpenAI-compatible endpoint:  moat run --base-url http://localhost:11434/v1 --model llama3 \"...\"",
    )
  }

  // --- boot -----------------------------------------------------------------
  const entry = codexEntryScript()

  // Both files are rendered on every boot and written through the rootfs guard: the agent's
  // home is inside the box, the config is what decides that Codex asks for no approvals and
  // adds no second sandbox next to moat's, and the brief is what tells the agent where it is.
  // A stale one from a cached image or an environment created days ago is a bug that already
  // happened once, so neither is left to provisioning.
  installCodexFiles(paths.rootfs, {
    config: renderCodexConfig({
      model: resolvedModel.modelID,
      providerID: "deepseek-moat",
      baseURL: baseUrl,
      // The native provider's key is read from its own variable; a custom endpoint reads moat's.
      // With --no-credential there is nothing to read, so no env_key is written at all.
      envKey: resolvedModel.native ? DEEPSEEK.envVar : credential ? "MOAT_INJECTED_CREDENTIAL" : undefined,
      reasoningEffort: effortFlag,
      contextWindow: resolvedModel.meta?.context,
      maxOutputTokens: resolvedModel.meta?.output,
    }),
    // Codex reads a global brief from its home directory (default ~/.codex, or CODEX_HOME if
    // that is set). Measured through the recording proxy: the content arrives in the request
    // body wrapped as AGENTS.md instructions, not in the top-level instructions field.
    brief: renderInstructions({ ...briefInput, workspace: SANDBOX_WORKDIR }),
  })

  const managedEnv: Record<string, string> = {
    // Configuration, not a secret: the custom-endpoint provider block needs the base
    // URL and the model whether or not a credential was injected. They used to arrive
    // only with the credential, so a --no-credential boot had a provider with no URL
    // at all and every model call died inside the box with ERR_INVALID_URL, silently.
    ...sandboxProviderEnv({ baseUrl, model: resolvedModel.model, modelId: resolvedModel.modelID }),
    ...(credential ? toSandboxEnv(credential) : {}),
  }
  // The escape hatch is spread first and the managed values last, and it may not
  // claim a managed name: MOAT_SANDBOX_ENV must not be able to replace the
  // credential or the provider configuration inside the box.
  const sandboxEnvVars: Record<string, string> = {
    ...extraSandboxEnv(process.env.MOAT_SANDBOX_ENV, Object.keys(managedEnv)),
    ...managedEnv,
  }

  report.egress = egress
  if (egress === "filtered") await ensureFilterTool(paths)
  const providerName = providerHost(baseUrl)
  const egressConfig = await runtimeForEgress(egress, {
    rootfs: paths.rootfs,
    allowHosts: [...defaultAllowHosts(providerName), ...egressAllow],
  })
  reportUnresolved(egressConfig.unresolved, providerName, egress === "filtered")
  const bootStart = Date.now()
  // A box that died out of band — killed, OOM, host reboot — leaves its slirp4netns
  // datapath running, because that is a separate process and only the commands that still
  // hold its pid on record reap it. Booting a new box overwrites state.json, so without
  // this the old datapath becomes unattributable and outlives even `moat destroy`.
  // Measured before the fix: one `kill -9` of the box, then `moat up` left two
  // slirp4netns processes, and `moat destroy` removed only the new one.
  if (state?.slirpPid && !sandboxAlive(state, paths)) await reapRecordedDatapath(state)

  const sandbox = await startSandbox(paths, entry, sandboxEnvVars, {
    egress,
    slirpBinary: egressConfig.slirpBinary,
    egressRules: egressConfig.egressRules,
  })
  // Wait for the box to say it is up before recording it as running. Spawning
  // `unshare` is not a boot: the entry script's first act is the credential
  // deadline, and an expired credential makes it exit 0 in milliseconds. Reporting
  // that as "sandbox booted" wrote a running pid into state.json for a process that
  // was already gone, and the failure surfaced later as a `moat exec` that could not
  // reach the box. A boot that dies must fail here, where the log can be shown.
  const ready = await waitForSandboxReady(sandbox.pid, () => readRootfsFileTail(paths.rootfs, "/var/log/moat/boot.log", LOG_TAIL_BYTES))
  if (!ready.ok) {
    await stopSandbox(sandbox.pid, {
      startTime: sandbox.startTime,
      envId: paths.id,
      slirpPid: sandbox.slirp?.pid ?? null,
      slirpStart: sandbox.slirp?.startTime ?? null,
    })
    if (state) await forgetBox(paths, state)
    const tail = sandboxLogTail(paths, 20)
    log.fail(`${ready.reason}\n  the last lines of the boot log:\n${tail}`)
  }
  state = {
    ...(state as EnvState),
    status: "running",
    pid: sandbox.pid,
    pidStart: sandbox.startTime,
    egress,
    egressAllow,
    slirpPid: sandbox.slirp?.pid ?? null,
    slirpStart: sandbox.slirp?.startTime ?? null,
    model: resolvedModel.model,
    providerBaseUrl: baseUrl,
    provider: provider.id,
    branch,
    baseBranch,
    profiles: resolvedProfiles.profiles,
    lastUpAt: new Date().toISOString(),
    credential: credential
      ? {
          provider: credential.provider,
          fingerprint: credential.fingerprint,
          mintedAt: credential.mintedAt.toISOString(),
          expiresAt: credential.expiresAt.toISOString(),
          // Recorded so copy-out can scan for the value even when it was passed as
          // `--credential-env NAME` rather than under one of the names moat knows by
          // convention. Without it the leak scan compared against nothing and said
          // nothing, which reads exactly like "no leak found".
          sourceEnvVars: [...credential.targetEnvVars, ...CREDENTIAL_ENV_NAMES],
        }
      : null,
  }
  writeState(paths, state)
  // There is no server to wait for, and every task, TUI session and check runs in
  // its own ephemeral boot of this rootfs, so "ready" is the entry script's own
  // readiness line (`waitForSandboxReady`, checked above) rather than a port.
  // --timeout is SECONDS and is the budget for one of those turns, not for this boot.
  log.step(`sandbox booted (pid ${sandbox.pid}); the codex runtime has no server to wait for`)
  const bootMs = Date.now() - bootStart

  // The value is only ever meant to exist in the sandbox process environment.
  // If it reached a file inside the rootfs, "no credential in the image" is
  // already false and the boot must not be reported as healthy.
  if (credential) {
    const leaks = scanRootfsForCredential(paths.rootfs, credential.value)
    if (leaks.length > 0) {
      await stopSandbox(sandbox.pid, {
        startTime: sandbox.startTime,
        envId: paths.id,
        slirpPid: sandbox.slirp?.pid ?? null,
        slirpStart: sandbox.slirp?.startTime ?? null,
      })
      await forgetBox(paths, state)
      log.fail(
        `the credential was found on disk inside the sandbox:\n  ${leaks.slice(0, 5).join("\n  ")}\n` +
          "  moat refuses to continue: the value is only meant to exist in the sandbox process environment.",
      )
    }
  }

  state.lastBootMs = bootMs
  writeState(paths, state)
  // The boot is over: from here on this process may sit in a session for hours,
  // and the environment is not "being booted" any more.
  endBoot(paths)

  // `moat up "fix the tests"` and `moat run "fix the tests"` are the same thing: bringing up a
  // box you are not going to use is not a step worth having. At a terminal, a task opens
  // Codex's own TUI with the task as its first message, so it can be steered while it runs;
  // a batch run drives one turn and reports it.
  const showOutput = flag<boolean>(p, "show-output") ?? false
  const timeoutSeconds = optionalPositiveIntFlag(p, "timeout")
  const runOptions = { env: sandboxEnvVars, egress, slirpBinary: egressConfig.slirpBinary, egressRules: egressConfig.egressRules }
  if (task.length > 0 && interactive) return await runInteractive(paths, codexTuiBody(task), runOptions)
  if (task.length > 0) return await runCodexTask(paths, codexExecBody(task), { ...runOptions, timeoutSeconds, showOutput, json })
  if (interactive) return await runInteractive(paths, codexTuiBody(), runOptions)

  report.status = "running"
  report.pid = sandbox.pid
  report.bootMs = bootMs
  report.totalMs = Date.now() - started
  report.readyCheck = `the entry script reported ready (${READY_MARKER})`
  report.credential = credential
    ? { provider: credential.provider, fingerprint: credential.fingerprint, expiresAt: credential.expiresAt, source: credential.source }
    : null
  report.host = describeHost(host)
  report.credentialsInSandboxEnv = Object.keys(sandboxEnvVars).sort()

  if (json) log.emit(report)
  else
    printUpSummary(paths, state, {
      coldStart: Date.now() - started,
      reused: false,
      provisioned: needsProvision,
      bootMs,
    })

  return 0
}

function printUpSummary(
  paths: EnvPaths,
  state: EnvState,
  timing: { coldStart: number; reused: boolean; provisioned: boolean; bootMs?: number },
): void {
  // Be precise about what was measured: a first boot builds the image (cold), a
  // later boot reuses it (warm). Both are reported, neither is called the other.
  const label = timing.reused
    ? "reused the running instance"
    : timing.provisioned
      ? `cold start ${ms(timing.coldStart)} (image built)`
      : `warm start ${ms(timing.coldStart)} (image reused)`
  log.success(`sandbox up, ${label}`)
  log.info("")
  log.info(`  project    ${paths.projectDir}`)
  log.info(`  env        ${paths.dir}`)
  // No server, so no endpoint and no password to report: the TUI and the tasks run in the
  // box's own rootfs, and the credential is what the box talks to the provider with.
  log.info(`  runtime    codex (${state.model ?? "default model"}): \`moat\` opens its TUI`)
  log.info(`  workspace  ${SANDBOX_WORKDIR} (inside the sandbox)`)
  if (state.credential) {
    log.info(`  credential ${state.credential.provider} ${state.credential.fingerprint} expires ${state.credential.expiresAt}`)
  }
  log.info("")
  log.info(`  next: ${log.bold("moat")}         ${log.dim("open a session here and tell it what to do")}`)
  log.info(`        ${log.bold("moat apply")}   ${log.dim("merge what it did into this directory")}`)
  log.info(`        ${log.bold("moat down")}    ${log.dim("stop the sandbox (state and snapshots are kept)")}`)
}

// ---------------------------------------------------------------------------
// moat fetch / apply
// ---------------------------------------------------------------------------

async function cmdFetch(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  requireState(paths)
  if (!(await isGitRepo(paths.projectDir))) {
    // Name the way out: `moat apply` merges the sandbox's tree without a host repository, and a
    // refusal that does not say so sends the user looking for a repository they do not have.
    log.fail(
      `${paths.projectDir} is not a git repository; there is nowhere to fetch into.\n` +
        "  moat apply merges the sandbox's work into this directory without one.",
    )
  }
  if (!(await isGitRepo(paths.work))) {
    log.fail("there is no repository in the sandbox yet. Run `moat up` first.")
  }

  const branches = await listSandboxBranches(paths)
  if (branches.length === 0) log.fail("the agent has not created any branch in the sandbox yet")

  // Uncommitted work is not in any ref, so `git fetch` cannot see it. Say so
  // rather than letting someone believe their sandbox work was collected.
  const dirty = await sandboxWorktreeChanges(paths)
  if (dirty.length > 0) {
    if (flag<boolean>(p, "commit-worktree")) {
      const committed = await commitSandboxWorktree(paths, "moat: uncommitted sandbox work, committed at fetch time")
      log.warn(
        `committed ${committed.files} uncommitted file(s) from the sandbox as ${committed.sha?.slice(0, 12)} ` +
          `before fetching, because you passed --commit-worktree`,
      )
    } else {
      log.warn(
        `the sandbox has ${dirty.length} uncommitted change(s); \`git fetch\` reads a branch ref and cannot see them.`,
      )
      for (const line of dirty.slice(0, 10)) log.info(`    ${stripAnsi(line)}`)
      if (dirty.length > 10) log.info(`    … and ${dirty.length - 10} more`)
      log.info("")
      log.info(`  to collect them:  moat fetch --commit-worktree   ${log.dim("(commits them in the sandbox, then fetches)")}`)
      log.info("  or ask the agent to commit inside the box")
      log.info("")
    }
  }

  const requested = p._.length > 0 ? p._ : undefined
  const targets = flag<boolean>(p, "all")
    ? branches.map((b) => b.name)
    : [requested?.[0] ?? (await suggestBranch(paths))]
  if (!targets[0]) log.fail("could not determine which branch to fetch; name one explicitly")

  // Prove the working tree is untouched, rather than asserting it.
  const before = hashTree(paths.projectDir)

  const results = []
  for (const branch of targets) {
    if (!branch) continue
    const known = branches.find((b) => b.name === branch)
    if (!known) {
      log.fail(
        `no branch "${stripAnsi(branch)}" in the sandbox. Available: ${branches.map((b) => stripAnsi(b.name)).join(", ")}`,
      )
    }
    results.push(await fetchBranch(paths, branch))
  }

  const after = hashTree(paths.projectDir)
  const worktreeUntouched = before.digest === after.digest

  if (flag<boolean>(p, "json")) {
    log.emit({ fetched: results, worktreeUntouched, projectDigestBefore: before.digest, projectDigestAfter: after.digest })
    return worktreeUntouched ? 0 : 1
  }

  for (const result of results) {
    log.success(`fetched ${stripAnsi(result.branch)} -> ${stripAnsi(result.hostRef)} (${result.sha.slice(0, 12)})`)
    log.info(`  ${result.commits} commit(s) reachable, HEAD ${result.headBefore?.slice(0, 12)} -> ${result.headAfter?.slice(0, 12)}`)
    for (const commit of result.commitsFetched.slice(0, 10)) {
      log.info(`    ${commit.sha.slice(0, 12)}  ${stripAnsi(commit.subject)}`)
    }
  }
  log.info("")
  log.info(`  the host working tree was recomputed and is ${worktreeUntouched ? log.green("byte-identical") : log.red("CHANGED")}`)
  log.info(`  inspect with:  git log ${results[0]!.hostRef}`)
  log.info(`  apply with:    moat apply ${results[0]!.branch}${log.dim("  (or --checkout)")}`)
  return worktreeUntouched ? 0 : 1
}

/**
 * Run the project's own checks against whatever is in the sandbox right now.
 *
 * An agent saying "the tests pass" is a claim. This is the evidence. No model is
 * involved: moat runs the command the project declares and reports what happened.
 */
async function cmdVerify(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  const state = requireState(paths)
  const runtime = await egressRuntime(state, paths)

  const checks = detectChecks(paths.projectDir)
  if (checks.length === 0) {
    log.warn("no test, lint or typecheck command found for this project")
    log.info("  moat looks at package.json scripts, Makefile targets, pyproject.toml, Cargo.toml and go.mod")
    return 0
  }

  log.step(`running ${checks.map((c) => c.command).join(", ")} inside the sandbox`)
  // `--timeout` is seconds, and the runner already takes it: without this it was
  // accepted and ignored, so a suite that hangs ran to the ten-minute default with
  // no way to shorten it from the CLI.
  const results = await runChecks(paths, checks, {
    // The project's own test output is written by code the agent can edit, and a
    // terminal acts on what it is given: OSC 0 retitles the window, OSC 52 writes the
    // clipboard, CSI 2J clears the screen, a carriage return repaints the row. This is
    // the command the user runs *instead of* trusting the agent, so the bytes go through
    // the same print boundary as every other string out of the sandbox. Stripping
    // per chunk is safe: stripAnsi removes every ESC byte, so nothing can be reassembled.
    onOutput: (chunk) => process.stderr.write(stripAnsi(chunk)),
    timeoutSeconds: optionalPositiveIntFlag(p, "timeout"),
    ...runtime,
  })

  if (flag<boolean>(p, "json")) {
    log.emit(results)
  } else {
    log.info("")
    for (const result of results) {
      const mark = result.ok ? log.green("pass") : log.red("FAIL")
      const detail = result.timedOut ? " (timed out)" : result.ok ? "" : ` (exit ${result.code})`
      log.info(`  ${mark}  ${result.label.padEnd(24)} ${log.dim(`${(result.ms / 1000).toFixed(1)}s${detail}`)}`)
    }
    log.info("")
  }
  return results.every((r) => r.ok) ? 0 : 1
}

/**
 * The one command most people actually want after an agent has worked:
 * bring the branch across, show what is in it, and stop.
 *
 * `moat fetch` + `git log` + `moat apply` is three commands and two concepts.
 * This is the same thing with the defaults filled in, and it still refuses to
 * touch the working tree unless asked.
 */
async function cmdTake(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  const state = requireState(paths)
  const runtime = await egressRuntime(state, paths)
  if (!(await isGitRepo(paths.projectDir))) {
    log.fail(`${paths.projectDir} is not a git repository; nothing to take into.\n  moat apply merges the sandbox's work into this directory without one.`)
  }

  const branches = await listSandboxBranches(paths)
  if (branches.length === 0) log.fail("the agent has not committed anything yet")
  const target = p._[0] ?? (await suggestBranch(paths))
  if (!target) log.fail("could not work out which branch to take; name one explicitly")

  const before = hashTree(paths.projectDir)
  const result = await fetchBranch(paths, target)
  const after = hashTree(paths.projectDir)

  log.info("")
  log.info(`${log.bold(target)}  ${result.commits} commit(s), ${result.sha.slice(0, 12)}`)
  for (const commit of result.commitsFetched.slice(0, 15)) {
    log.info(`  ${log.dim(commit.sha.slice(0, 10))}  ${stripAnsi(commit.subject)}`)
  }

  const changed = await run("git", ["-C", paths.projectDir, "diff", "--stat", result.headBefore ?? "HEAD", result.hostRef], {
    env: SANITIZED_GIT_ENV,
    allowFailure: true,
  })
  if (changed.stdout.trim()) {
    log.info("")
    log.info(changed.stdout.trimEnd())
  }

  // The point of take is to decide whether to keep the work, and the single most
  // useful input to that decision is whether the project's own checks pass on it.
  let verified: { ok: boolean; summary: string } | null = null
  if (!flag<boolean>(p, "no-verify")) {
    const checks = detectChecks(paths.projectDir)
    if (checks.length > 0) {
      log.step(`verifying: ${checks.map((c) => c.command).join(", ")}`)
      const results = await runChecks(paths, checks, {
        timeoutSeconds: optionalPositiveIntFlag(p, "timeout"),
        ...runtime,
      })
      verified = { ok: results.every((r) => r.ok), summary: summarise(results) }
      log.info("")
      for (const check of results) {
        const mark = check.ok ? log.green("pass") : log.red("FAIL")
        log.info(`  ${mark}  ${check.label.padEnd(24)} ${log.dim(`${(check.ms / 1000).toFixed(1)}s`)}`)
        if (!check.ok) {
          for (const line of check.output.split("\n").slice(-6)) log.info(`      ${log.dim(stripAnsi(line))}`)
        }
      }
    }
  }

  log.info("")
  if (verified) {
    log.info(`  checks:  ${verified.ok ? log.green(verified.summary) : log.red(verified.summary)}`)
  }
  log.info(`  your working tree is ${before.digest === after.digest ? log.green("untouched") : log.red("CHANGED")}`)
  log.info(`  review:  git log ${result.hostRef}`)
  log.info(`  accept:  moat apply` + log.dim("   (three-way merge into your tree)"))
  log.info(`           moat apply ${target} --checkout` + log.dim("   (or switch to the agent's branch)"))
  log.info(`  reject:  git update-ref -d ${result.hostRef}`)
  return before.digest === after.digest ? 0 : 1
}

/** Accept `moat apply <branch>`, `refs/moat/<branch>` or `refs/heads/<branch>`. */
function normaliseBranchRef(input: string): string {
  return input.replace(/^refs\/moat\//, "").replace(/^refs\/heads\//, "")
}

async function cmdApply(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  const state = requireState(paths)

  const branchArg = p._[0]
  const checkout = flag<boolean>(p, "checkout") ?? false
  const localName = flag<string>(p, "name")
  const json = flag<boolean>(p, "json") ?? false

  // `moat apply <branch>` acts on a fetched ref: it creates the local branch,
  // and only switches to it when --checkout is passed. This is what SPEC §2.4
  // and `moat take` have said all along; before, the branch argument, --checkout
  // and --name were accepted and ignored, and the command silently ran the
  // live-tree merge instead.
  if (branchArg) {
    const branch = normaliseBranchRef(branchArg)
    const ref = `refs/moat/${branch}`
    const exists = await run("git", ["-C", paths.projectDir, "rev-parse", "--verify", "--quiet", ref], {
      env: SANITIZED_GIT_ENV,
      allowFailure: true,
    })
    if (exists.code !== 0) {
      // Fetch it rather than telling the user to run a second command; the ref
      // is the whole input this mode needs.
      await fetchBranch(paths, branch)
    }
    if (flag<boolean>(p, "dry-run")) {
      if (json) log.emit({ branch, ref, checkout, local: localName ?? null, dryRun: true })
      else log.info(`would ${checkout ? "check out" : "create"} a local branch from ${ref}`)
      return 0
    }
    const result = await applyBranch(paths, branch, { name: localName, checkout })
    if (json) log.emit({ ...result, checkout })
    else {
      log.success(
        `${checkout ? "checked out" : "created"} local branch ${stripAnsi(result.branch)} at ${stripAnsi(result.ref)}`,
      )
    }
    return 0
  }
  if (checkout) log.fail("--checkout needs a branch: moat apply <branch> --checkout")
  if (localName) log.fail("--name needs a branch: moat apply <branch> --name <local>")

  const plan = await planApply(paths)

  // A missing or moved baseline is not "nothing to do": without the commit moat
  // recorded at copy-in there is no third input to merge against, and applying
  // would be a guess. Fail loudly; the old behaviour reported success.
  if (plan.baselineProblem) {
    log.fail(plan.baselineProblem)
    return 1
  }
  if (state.baselineCommit && plan.baselineCommit && state.baselineCommit !== plan.baselineCommit) {
    log.fail(
      `refs/moat/baseline has moved since moat recorded it (${state.baselineCommit.slice(0, 12)} -> ${plan.baselineCommit.slice(0, 12)}).\n` +
        "  Something rewrote the sandbox repository's baseline, so moat cannot tell your changes from the agent's.\n" +
        "  Run 'moat up --sync' to re-copy the project, or fetch the branch and merge it by hand.",
    )
    return 1
  }
  if (plan.empty) {
    log.info("nothing to apply: the directory already matches the sandbox")
    return 0
  }

  if (!flag<boolean>(p, "json")) {
    log.info("")
    for (const line of describePlan(plan)) log.info(`  ${stripAnsi(line)}`)
    for (const conflict of plan.conflicts) {
      log.info(`  ${log.yellow("skip")}    ${stripAnsi(conflict.path)}  ${log.dim(conflict.note ?? "conflict")}`)
    }
    log.info("")
  }

  if (flag<boolean>(p, "dry-run")) {
    if (flag<boolean>(p, "json")) log.emit(plan)
    else log.info(`  ${plan.changes.length - plan.conflicts.length} change(s) ready, ${plan.conflicts.length} conflict(s). Nothing written (--dry-run).`)
    return 0
  }

  // A conflict means moat cannot decide, so it stops rather than half-applying.
  // That is the one place this tool refuses to guess.
  if (plan.conflicts.length > 0 && !flag<boolean>(p, "skip-conflicts")) {
    if (flag<boolean>(p, "json")) log.emit(plan)
    else {
      log.warn(
        `${plan.conflicts.length} file(s) changed on both sides and could not be merged automatically. ` +
          "Nothing has been written.",
      )
      log.info("")
      log.info(`  the agent's version is in the sandbox:  moat exec -- cat /work/<path>`)
      log.info(`  the baseline is recorded at refs/moat/baseline in the sandbox repository`)
      log.info(`  to apply everything else and leave those alone:  moat apply --skip-conflicts`)
    }
    return 1
  }

  const result = await applyPlan(paths, plan)
  if (flag<boolean>(p, "json")) log.emit({ ...plan, ...result })
  else {
    log.success(`applied ${result.applied} change(s) to ${paths.projectDir}`)
    if (result.skipped.length > 0)
      log.warn(`left alone: ${result.skipped.map((item) => stripAnsi(item)).join(", ")}`)
  }
  return 0
}

// ---------------------------------------------------------------------------
// down / destroy / status / snapshot / restore / logs
// ---------------------------------------------------------------------------

async function cmdDown(argv: string[]): Promise<number> {
  parse(argv, SPEC) // validates flags; `down` takes no options of its own
  const paths = resolveEnv()
  // A boot in flight would make the state below read as "not running". Wait for
  // it, then stop the box it produced: that is what "down" was asked to do.
  await awaitBoot(paths, "stopping the sandbox")
  const state = requireState(paths)
  const status = sandboxPidStatus(state.pid, { startTime: state.pidStart, envId: paths.id })
  if (status === "gone") {
    // The box is gone, but its datapath is a separate process and may not be, and this
    // branch is about to drop the only record of it.
    await forgetBox(paths, state)
    log.info("sandbox is not running")
    return 0
  }
  if (status === "stale") {
    // Same as the gone branch: the recorded datapath is still ours by pid and start
    // time even though the recorded box is not.
    await forgetBox(paths, state)
    log.warn(
      `the recorded sandbox is gone: pid ${state.pid} now belongs to another process, so moat did not signal it.`,
    )
    log.info("  the environment and its snapshots are kept")
    return 0
  }
  if (
    await stopSandbox(state.pid!, {
      startTime: state.pidStart,
      envId: paths.id,
      slirpPid: state.slirpPid,
      slirpStart: state.slirpStart,
    })
  ) {
    await forgetBox(paths, state)
    log.success(`sandbox stopped (pid ${state.pid}); the environment and its snapshots are kept`)
    log.info(`  resume with: moat up`)
    log.info(`  remove with: moat destroy`)
  } else {
    log.fail(`could not stop sandbox pid ${state.pid}`)
  }
  return 0
}

async function cmdDestroy(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  await awaitBoot(paths, "destroying the environment")

  // `--all` exists because cleaning up one directory at a time is no way to
  // reclaim disk, and because a single mistake (moat in $HOME) can cost tens of
  // gigabytes that the user needs a way to find and remove.
  if (flag<boolean>(p, "all")) {
    const envs = listEnvs()
    if (envs.length === 0) {
      log.info("no moat environments")
      return 0
    }
    let freed = 0
    let removed = 0
    for (const env of envs) {
      // One environment booting must not make `--all` wait for minutes, and
      // deleting one mid-boot is how a live sandbox ends up with a deleted
      // rootfs. It is skipped with a reason and is reclaimable next run.
      const booting = bootInFlight(env)
      if (booting) {
        log.warn(`skipping ${env.id}: ${booting.command} is booting it (pid ${booting.pid})`)
        continue
      }
      const envState = readState(env)
      const size = await rootfsSizeBytes(env)
      if (envState?.pid) {
        // stopSandbox reaps the recorded datapath too, whether or not the box answered.
        await stopSandbox(envState.pid, {
          startTime: envState.pidStart,
          envId: envState.id,
          slirpPid: envState.slirpPid,
          slirpStart: envState.slirpStart,
        })
      } else {
        // A state that recorded a datapath but no box pid still names a process moat
        // started, and deleting the environment deletes the record with it.
        await reapRecordedDatapath(envState)
      }
      if (destroyEnv(env)) {
        freed += size
        removed += 1
        log.info(`  removed ${env.id}  ${human(size)}  ${env.projectDir}`)
      }
    }
    log.success(`destroyed ${removed} environment(s), about ${human(freed)}`)
    if (removed < envs.length) {
      log.warn(`${envs.length - removed} environment(s) were left alone; run this again when the boot is done`)
    }
    return 0
  }

  const state = readState(paths)
  if (state && sandboxAlive(state, paths)) {
    if (!flag<boolean>(p, "yes")) {
      log.fail("sandbox is running. Stop it first, or pass --yes to destroy it while running.")
    }
    await stopSandbox(state.pid!, {
      startTime: state.pidStart,
      envId: paths.id,
      slirpPid: state.slirpPid,
      slirpStart: state.slirpStart,
    })
  } else {
    // The recorded box is gone or is no longer ours, so nothing above touched the
    // datapath — and destroyEnv is about to delete the only record of it. Measured
    // before this: the box was killed out of band, destroy removed the environment and
    // left the slirp4netns process running with nothing naming it.
    await reapRecordedDatapath(state)
  }
  const removed = destroyEnv(paths)
  if (removed) log.success(`destroyed ${paths.dir}`)
  else log.info("nothing to destroy")
  return 0
}

async function cmdStatus(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = p._.length > 0 ? envPaths(p._[0]!) : resolveEnv()
  if (p._.length > 0 && !fs.existsSync(paths.state)) log.fail(`no environment for ${paths.projectDir}`)

  const all = flag<boolean>(p, "all")
  if (all) {
    const envs = listEnvs()
    const rows = []
    for (const env of envs) {
      // An environment with no readable state is not "nothing to show": it is a
      // directory holding disk that the user has to be able to see and reclaim.
      const state = readState(env)
      // "orphaned" is the state that matters here: the environment still holds
      // disk, but its project directory is gone, so nothing can boot or apply.
      const orphaned = !state || !fs.existsSync(env.projectDir)
      rows.push({
        id: state?.id ?? env.id,
        project: state?.projectDir ?? env.projectDir,
        status: orphaned ? "orphaned" : sandboxAlive(state, env) ? "running" : "stopped",
        pid: state?.pid ?? null,
        credential: state?.credential?.expiresAt ?? null,
        bytes: await rootfsSizeBytes(env),
      })
    }
    if (flag<boolean>(p, "json")) log.emit(rows)
    else if (rows.length === 0) log.info("no moat environments")
    else {
      let total = 0
      for (const row of rows) {
        total += row.bytes
        log.info(`${row.status.padEnd(8)} ${human(row.bytes).padStart(9)}  ${row.project}`)
      }
      log.info(`${"".padEnd(8)} ${human(total).padStart(9)}  total, across ${rows.length} environment(s)`)
      if (rows.some((row) => row.status === "orphaned")) {
        log.info(`  ${log.dim("orphaned: the project directory is gone; moat destroy --all reclaims them")}`)
      }
      log.info(`  ${log.dim("reclaim it with: moat destroy --all")}`)
    }
    return 0
  }

  const booting = bootInFlight(paths)
  const state = readState(paths)
  if (!state && booting) {
    // state.json is written after provisioning, so "no environment" is the wrong
    // answer while a boot is in progress: the environment is being created now.
    if (flag<boolean>(p, "json")) {
      log.emit({ project: paths.projectDir, envDir: paths.dir, status: "provisioning", boot: booting })
    } else {
      log.info(`project      ${paths.projectDir}`)
      log.info(`env          ${paths.dir}`)
      log.info(`status       ${log.cyan(`booting (pid ${booting.pid}, ${bootAgeSeconds(booting)}s in)`)}`)
    }
    return 0
  }
  if (!state) log.fail(`no moat environment for ${paths.projectDir}. Run \`moat up\` first.`)
  const running = sandboxAlive(state!, paths)
  if (running !== (state!.status === "running")) {
    state!.status = running ? "running" : "stopped"
    if (!running) {
      state!.pid = null
      state!.pidStart = null
    }
    writeState(paths, state!)
  }
  const snapshots = await listSnapshots(paths)
  const payload = {
    ...state!,
    envDir: paths.dir,
    rootfsDir: paths.rootfs,
    running,
    booting: booting ? { pid: booting.pid, startedAt: booting.startedAt, command: booting.command } : null,
    snapshots: snapshots.map((s) => s.name),
    rootfsBytes: await rootfsSizeBytes(paths),
    sandboxBranches: fs.existsSync(path.join(paths.work, ".git")) ? await listSandboxBranches(paths) : [],
  }
  if (flag<boolean>(p, "json")) log.emit(payload)
  else {
    log.info(`project      ${state!.projectDir}`)
    log.info(`env          ${paths.dir}`)
    log.info(
      `status       ${booting ? log.cyan(`booting (pid ${booting.pid}, ${bootAgeSeconds(booting)}s in)`) : running ? log.green("running") : log.yellow("stopped")}`,
    )
    // No server, no endpoint and no password: the version that matters is the runtime's.
    log.info(`codex        ${CODEX_VERSION} / alpine ${state!.alpineVersion}`)
    if (state!.pid) log.info(`pid          ${state!.pid}`)
    if (state!.model) log.info(`model        ${state!.model}${state!.provider ? ` (${state!.provider})` : ""}`)
    if (state!.branch) log.info(`branch       ${state!.branch}`)
    const egressLabel =
      state!.egress === "filtered"
        ? "filtered (own network namespace, default-deny allowlist)"
        : state!.egress === "isolated"
          ? "isolated (own network namespace)"
          : "open (host network namespace)"
    log.info(`egress       ${egressLabel}`)
    if (state!.profiles && state!.profiles.length > 0) log.info(`profiles     ${state!.profiles.join(", ")}`)
    log.info(`rootfs       ${human(payload.rootfsBytes)}`)
    if (state!.credential) {
      const remaining = Math.round((new Date(state!.credential.expiresAt).getTime() - Date.now()) / 1000)
      const note = remaining <= 0 ? log.red(" (EXPIRED: the box stops at this deadline)") : ""
      log.info(`credential   ${state!.credential.provider} ${state!.credential.fingerprint} expires in ${remaining}s${note}`)
    }
    log.info(`snapshots    ${snapshots.map((s) => s.name).join(", ") || "none"}`)
    if (payload.sandboxBranches.length > 0) {
      log.info(
      `branches     ${payload.sandboxBranches.map((b) => `${stripAnsi(b.name)}${b.current ? "*" : ""}`).join(", ")}`,
    )
    }
  }
  return 0
}

async function cmdSnapshot(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  const state = requireState(paths)
  const name = p._[0] ?? `snap-${new Date().toISOString().replace(/[:.]/g, "-")}`
  // Tarring a live or half-built rootfs can capture a torn state: a half-written
  // package database, a provisioning step in progress. Snapshots are not
  // destructive, so this is a gate --yes can open rather than a refusal.
  const booting = bootInFlight(paths)
  if (booting && !flag<boolean>(p, "yes")) {
    log.fail(
      `a boot of this environment is in progress (pid ${booting.pid}, ${bootAgeSeconds(booting)}s in); a snapshot ` +
        "taken now can capture a torn rootfs.\n  wait for `moat up` to finish, or pass --yes to snapshot it as it is.",
    )
  }
  if (state.pid && sandboxAlive(state, paths) && !flag<boolean>(p, "yes")) {
    log.fail(
      `the sandbox is running (pid ${state.pid}); a snapshot of a live rootfs can capture a torn state.\n` +
        "  run \`moat down\` first, or pass --yes to snapshot it as it is.",
    )
  }
  const result = await snapshotEnv(paths, name)
  log.success(`snapshot ${name} (${human(result.bytes)}) -> ${result.file}`)
  return 0
}

async function cmdRestore(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  // Replacing the rootfs while a boot is writing it is the same mistake as
  // restoring under a running box, one step earlier.
  await awaitBoot(paths, "restoring the rootfs")
  const state = requireState(paths)
  const name = p._[0]
  if (!name) log.fail(`usage: moat restore <name>\navailable: ${(await listSnapshots(paths)).map((s) => s.name).join(", ")}`)

  // Restoring replaces the rootfs directory. A running sandbox has that
  // directory bound as its root, so it would keep serving the *deleted* image
  // while the host sees the new one. Refuse rather than silently produce that.
  if (state.pid && sandboxAlive(state, paths)) {
    if (!flag<boolean>(p, "yes")) {
      log.fail(
        `the sandbox is running (pid ${state.pid}). Restoring its rootfs underneath it would leave it serving a ` +
          `deleted image. Stop it first (\`moat down\`) or pass --yes to stop it as part of the restore.`,
      )
    }
    await stopSandbox(state.pid, {
      startTime: state.pidStart,
      envId: paths.id,
      slirpPid: state.slirpPid,
      slirpStart: state.slirpStart,
    })
    await forgetBox(paths, state)
    log.info(`stopped sandbox pid ${state.pid} before restoring`)
  } else if (state.pid) {
    // Not our box (stale pid, or nothing listening), but the datapath is matched by pid
    // and start time.
    await forgetBox(paths, state)
  }
  await restoreEnv(paths, name!)
  log.success(`restored rootfs snapshot ${name} (the project copy in /work was preserved)`)
  return 0
}

function tailText(text: string, lines: number): string {
  return text.split("\n").slice(-lines).join("\n")
}

function tailFile(file: string, lines: number): string {
  if (!fs.existsSync(file)) return "(no log)"
  return tailText(stripAnsi(fs.readFileSync(file, "utf8")), lines)
}

/** Read at most this much of an agent-controlled log: it decides the file's size. */
const LOG_TAIL_BYTES = 512 * 1024

/**
 * The boot log lives inside the rootfs, which the agent can write to: a symlink
 * there would make this read a host file and print it, and a log the agent grew to
 * gigabytes would be pulled into memory. `readRootfsFileTail` refuses the symlink
 * and reads only the tail, so a redirected path reads as "(no log)" and a huge
 * one is simply truncated.
 */
function rootfsLogTail(paths: EnvPaths, target: string, lines: number): string {
  const text = readRootfsFileTail(paths.rootfs, target, LOG_TAIL_BYTES)
  // An empty boot log means the boot died before the dup, so the lines that did
  // make it are in logs/sandbox.log outside the box. Report "(no log)" and let the
  // caller fall back to it, as it did when the file was not created at all.
  if (text === null || text.trim().length === 0) return "(no log)"
  // The agent can write anything into its own log, escape sequences included,
  // and this text goes to the user's terminal.
  return tailText(stripAnsi(text), lines)
}

/**
 * The sandbox's own log.
 *
 * The long-running box redirects its output to a file inside its rootfs, so it
 * never holds an append fd on a host path outside itself. The host-side
 * `logs/sandbox.log` only carries the few lines before that redirect, and is
 * the fallback when the boot died before it got there.
 */
function sandboxLogTail(paths: EnvPaths, lines: number): string {
  const boot = rootfsLogTail(paths, "/var/log/moat/boot.log", lines)
  if (boot !== "(no log)") return boot
  return tailFile(path.join(paths.logs, "sandbox.log"), lines)
}

async function cmdLogs(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  requireState(paths)
  const lines = positiveIntFlag(p, "tail", 80)
  const which_ = p._[0] ?? "sandbox"
  if (which_ === "sandbox") {
    log.info(sandboxLogTail(paths, lines))
    return 0
  }
  try {
    validateLogName(which_)
  } catch (error) {
    log.fail((error as Error).message)
  }
  log.info(tailFile(path.join(paths.logs, `${which_}.log`), lines))
  return 0
}

// ---------------------------------------------------------------------------
// moat doctor / shell / env
// ---------------------------------------------------------------------------

async function cmdDoctor(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const host = await probeHost()
  const paths = resolveEnv()
  const out: Record<string, unknown> = {
    host,
    credential: {
      envVar: DEEPSEEK.envVar,
      present: Boolean(process.env[DEEPSEEK.envVar] || process.env.MOAT_CREDENTIAL),
    },
  }

  if (!flag<boolean>(p, "json")) {
    log.info(`${log.bold("host")}`)
    log.info(`  platform   ${describeHost(host)}`)
    log.info(`  unshare    ${host.unshare ?? "MISSING"}`)
    log.info(`  chroot     ${host.chroot ?? "MISSING"}`)
    log.info(`  user ns    ${host.userns ? log.green("available") : log.red("unavailable")}`)
    log.info(`  pid ns     ${host.pidns ? log.green("available") : log.red("unavailable")}`)
    log.info(`  /dev/kvm   ${host.kvm ? "present" : "absent (v1 microVM path unavailable here)"}`)
    for (const note of host.notes) log.info(`  note       ${note}`)
    for (const problem of host.problems) log.info(`  ${log.red("problem")}   ${problem}`)
  }

  if (!flag<boolean>(p, "json")) {
    log.info("")
    log.info(`${log.bold("credential")}`)
    const hasKey = Boolean(process.env[DEEPSEEK.envVar] || process.env.MOAT_CREDENTIAL)
    log.info(
      hasKey
        ? `  ${DEEPSEEK.envVar}  ${log.green("set")}`
        : `  ${DEEPSEEK.envVar}  ${log.yellow("not set")}  ${log.dim("run `moat` at a terminal and it will ask for one")}`,
    )
  }

  const state = readState(paths)
  if (!state) {
    log.info("")
    log.info(`no environment for ${paths.projectDir} yet. Just run ${log.bold("moat")} in the directory you want to work in.`)
    if (flag<boolean>(p, "json")) log.emit(out)
    return host.problems.length === 0 ? 0 : 1
  }

  let isolation: IsolationReport | null = null
  if (envExists(paths)) {
    log.step("running in-sandbox isolation checks")
    // The probe boot runs in the same kind of network as the real box, so
    // "host loopback reachable" measures the policy the agent actually gets.
    const runtime = await egressRuntime(state, paths)
    isolation = await runIsolationChecks(paths, {
      hostHome: process.env.HOME ?? "",
      // The probe has to look like the box the agent gets, and the box's own state says
      // what that is: the credential names only when one was injected (a --no-credential
      // box has none, and injecting them made the doctor report a credential exposure for
      // it), and the provider's variable only for the native provider (a custom endpoint
      // gets the value under moat's name, never as DEEPSEEK_API_KEY).
      injectedVarNames: doctorInjectedVarNames({
        credential: Boolean(state.credential),
        native: state.provider === undefined || state.provider === DEEPSEEK.id,
      }),
      // In filtered mode the doctor proves both sides: an arbitrary address is
      // refused and the provider the environment actually uses is reachable.
      allowedProbe: providerProbe(state.providerBaseUrl ?? DEEPSEEK.baseUrl),
      ...runtime,
    })
    out.isolation = isolation
    if (!flag<boolean>(p, "json")) printIsolation(isolation)
  }

  if (flag<boolean>(p, "json")) log.emit(out)
  // Exposures are a documented design choice, not a failure of the box; notes are
  // context. Only genuine assertion failures make `doctor` exit non-zero.
  const failed = isolation
    ? isolation.checks.filter((c) => !c.ok && c.kind !== "note" && c.kind !== "exposure").length
    : 0
  return host.problems.length === 0 && failed === 0 ? 0 : 1
}

function printIsolation(report: IsolationReport): void {
  const checks = report.checks.filter((c) => (c.kind ?? "check") === "check")
  const exposures = report.checks.filter((c) => c.kind === "exposure")
  const notes = report.checks.filter((c) => c.kind === "note")

  log.info("")
  log.info(`${log.bold("isolation")} (${checks.length} checks)`)
  for (const check of checks) {
    log.info(`  ${check.ok ? log.green("pass") : log.red("FAIL")}  ${check.name.padEnd(30)} ${log.dim(check.detail)}`)
  }

  if (exposures.length > 0) {
    log.info("")
    log.info(`${log.bold("exposures")}, measured, and NOT fixed in v0. Read these before trusting the box.`)
    for (const check of exposures) {
      log.info(`  ${log.yellow("expose")}  ${log.bold(check.name)}`)
      log.info(`          ${log.dim(check.detail)}`)
    }
  }

  if (notes.length > 0) {
    log.info("")
    for (const note of notes) log.info(`  ${log.yellow("note")}  ${note.name.padEnd(30)} ${log.dim(note.detail)}`)
  }

  log.info("")
  log.info(`${log.bold("mount table inside the sandbox")}`)
  for (const line of report.mounts) log.info(`  ${line}`)
}

/**
 * Run one command inside a fresh boot of the environment's sandbox.
 *
 * This is an inspection tool, not an agent path: it exists so that verification
 * (and a human debugging a box) can look at the sandbox directly without going
 * through the model. It uses the same rootfs, so it sees whatever the agent
 * installed.
 */
async function cmdExec(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  const state = requireState(paths)
  const runtime = await egressRuntime(state, paths)
  const command = p._
  if (command.length === 0) log.fail("usage: moat exec -- <command> [args...]")
  const body = `#!/bin/sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
cd ${SANDBOX_WORKDIR}
exec ${command.map((arg) => shellQuote(arg)).join(" ")}
`
  const result = await runInSandbox(paths, body, { onOutput: (chunk) => process.stdout.write(chunk), ...runtime })
  return result.code
}

async function cmdShell(argv: string[]): Promise<number> {
  parse(argv, SPEC) // validates flags; `shell` takes no options of its own
  const paths = resolveEnv()
  const state = requireState(paths)
  const runtime = await egressRuntime(state, paths)
  const body = `#!/bin/sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
cd ${SANDBOX_WORKDIR}
echo "[moat] sandbox shell, this is inside the box, not your host"
exec /bin/bash -l
`
  return await runInteractive(paths, body, runtime)
}

/** `moat models`, what DeepSeek actually offers, straight from the catalog. */
async function cmdModels(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  // One provider by design (SPEC section 1, invariant 8). This used to ignore the
  // argument entirely: `moat models bogus` listed DeepSeek and exited 0, which
  // reads as "bogus is a provider moat knows".
  const requested = p._[0]
  if (requested !== undefined && requested.toLowerCase() !== DEEPSEEK.id) {
    log.fail(`moat has one provider (${DEEPSEEK.id}); there is no "${requested}" to list`)
  }
  const catalog = await loadCatalog({ refresh: flag<boolean>(p, "refresh") ?? false })

  const entry = catalog?.get(DEEPSEEK.id)
  const models = entry
    ? [...entry.models].sort((a, b) => (b.context ?? 0) - (a.context ?? 0))
    : FALLBACK_MODELS.map((id) => ({ id, toolCall: true, context: undefined, output: undefined }))

  if (flag<boolean>(p, "json")) {
    log.emit({
      provider: DEEPSEEK.id,
      endpoint: entry?.api ?? DEEPSEEK.baseUrl,
      env: DEEPSEEK.envVar,
      default: DEEPSEEK.defaultModel,
      source: entry ? "models.dev catalog" : "built-in fallback (catalog unavailable)",
      models,
    })
    return 0
  }

  log.info("")
  log.info(`${log.bold(DEEPSEEK.label)}  env=${DEEPSEEK.envVar}  ${log.dim(entry?.api ?? DEEPSEEK.baseUrl)}`)
  if (!entry) log.info(`  ${log.yellow("catalog unavailable, showing the built-in list")}`)
  log.info(`  ${"model".padEnd(30)} ${"context".padStart(7)} ${"output".padStart(7)}  tools`)
  for (const model of models) {
    const isDefault = model.id === DEEPSEEK.defaultModel ? log.green(" *") : "  "
    log.info(
      `${isDefault}${model.id.padEnd(28)} ${formatTokens(model.context).padStart(7)} ` +
        `${formatTokens(model.output).padStart(7)}  ${model.toolCall ? "yes" : log.yellow("NO")}`,
    )
  }
  log.info("")
  log.info(`  ${log.dim("* = default. Override with: moat run --model <id> \"...\"")}`)
  return 0
}

/** `moat profiles`, what the sandbox can be given. */
async function cmdProfiles(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  if (flag<boolean>(p, "json")) {
    // The machine-readable form is the whole table, not a stub. This used to emit
    // `{"base": [...]}` and then fall through to the human text: the ternary that
    // was meant to choose between the two shapes was statically undefined, and
    // there was no `return`, so `--json` printed a partial object *and* the prose.
    log.emit({
      base: BASE_PACKAGES,
      profiles: PROFILES.map((profile) => ({
        id: profile.id,
        label: profile.label,
        packages: profile.packages,
        post: profile.post ?? [],
        note: profile.note,
      })),
      full: FULL_PROFILE_ID,
      baseProfileCount: BASE_PACKAGES.length,
    })
    return 0
  }
  log.info("")
  log.info(`${log.bold("toolchain profiles")}, added with --profile, installed on demand, persisted`)
  log.info(describeProfiles())
  log.info(`  ${"full".padEnd(10)} ${"everything above".padEnd(34)}`)
  log.info("")
  log.info(`  usage: moat up --profile node,python,cc`)
  log.info(`         moat up --profile full`)
  log.info("")
  log.info(`${log.bold("base packages")} (always installed)`)
  log.info(`  ${BASE_PACKAGES.join(" ")}`)
  return 0
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const HELP = `moat runs an AI coding agent in a disposable sandbox. Your project is copied in, never mounted.

Usage: moat <command> [options]

  moat run "<task>"      boot if needed, do the task, stream the work
  moat take              review what the agent did; runs the project's own checks
  moat verify            just run those checks against the sandbox, no fetching
  moat down              stop the sandbox; nothing is lost
  moat status            what is running, on which model, with how much time left

That is the whole loop. Everything below exists but you should not need it.

Working inside a running box
  moat run "<task>"      give it another task
  moat shell             a plain shell inside the sandbox
  moat exec -- <cmd>     run one command inside the sandbox

Branches and history
  moat fetch [branch]    bring the agent's branch across into refs/moat/*
                         --commit-worktree  also commit anything left uncommitted
  moat take [branch]     fetch, show, and offer to apply
  moat apply             merge the agent's work into this directory
                         --dry-run          show the plan, write nothing
                         --skip-conflicts   apply what can be merged, leave the rest

The environment
  moat up [task]         start it without a task; --profile, --fresh, --sync, --yes live here
  moat profiles          toolchain profiles the sandbox can be given
  moat models [provider] what the model catalog offers, with context windows
  moat destroy           delete this project's environment and snapshots
  moat snapshot [name]   save the rootfs; moat restore <name> brings it back

Diagnostics
  moat doctor            host support, the in-sandbox isolation checks, the measured exposures
  moat logs [sandbox]
  moat version

Options that apply to up/run
  --model ID             DeepSeek model id; see: moat models
  --effort LEVEL         reasoning effort: low, high or max, the levels the
                         vendored DeepSeek model catalog declares. Renders Codex's
                         model_reasoning_effort; default is the catalog's own.
  --profile LIST         node,python,cc,go,rust,java,db,net,browser,cli,full
                         (auto-detected from the project if you do not say)
  --no-detect            do not guess a profile from the project
  --base-url URL         point at any OpenAI-compatible endpoint instead of DeepSeek.
                         Must be an http:// or https:// URL with a host: a
                         scheme-less localhost:11434/v1 has no host to allow.
  --upstream URL         keep DeepSeek but send its traffic elsewhere (a gateway,
                         or a proxy you are inspecting). Unlike --base-url this
                         keeps the catalog: context window, price, effort levels.
                         Same URL rule as --base-url.
  --credential-env NAME  host env var holding the key   --credential-ttl 4h
  --egress MODE          open, isolated or filtered. Default: filtered, which puts
                         the box in its own namespace behind a default-deny
                         allowlist (provider + package registries). A provider on
                         the host's loopback defaults to open instead, because the
                         box cannot reach it there.
  --egress-allow HOSTS   extra hosts the filtered allowlist permits, comma-separated
  --timeout SECONDS      how long one turn may take (default 2700). Seconds, always.
  --no-follow            run the task headless instead of opening Codex's TUI
  --show-output          print each tool's output as it runs
  --json                 machine-readable output on stdout

Options that apply to every command
  --help                 print this text instead of running the command
  --quiet                hide the progress lines; warnings and results still print
  --verbose              extra diagnostics on stderr

A flag a command does not read is refused rather than ignored.

Docs: docs/SPEC.md, docs/VERIFICATION.md
`

// ---------------------------------------------------------------------------
// the codex runtime
// ---------------------------------------------------------------------------

/**
 * The long-running box under the codex runtime.
 *
 * Codex is a CLI, not a server: there is nothing to wait for and nothing listening. The box
 * exists so `moat status`, `down` and `destroy` keep their meaning. Tasks and the TUI run in
 * their own ephemeral boots of the same rootfs, like `moat exec`.
 *
 * It also enforces the credential deadline, which is the box's own promise: the timestamp
 * comes from the host (`MOAT_CREDENTIAL_EXPIRES_EPOCH`), and the box exits when it passes. A
 * credential that is already dead at boot stops the box instead of leaving one that cannot
 * call a model. The deadline is the credential's own expiry, not a TTL counted from this
 * script's start — counting from the start let a box outlive its key by however long the boot
 * took, and that was a measured bug under the runtime this one replaced.
 */
function codexEntryScript(): string {
  return `#!/bin/sh
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
# The deadline is checked BEFORE the readiness line, and that order is the point.
# With the ready line first, a box whose credential was already dead printed
# "codex runtime ready" and then exited, so moat up waited for the marker, saw it,
# and recorded a running sandbox that was already gone: the same false success as
# spawning and not waiting at all, one layer further in. Nothing here can be
# reported as ready until the box has something it can actually call a model with.
EXPIRES_EPOCH=\${MOAT_CREDENTIAL_EXPIRES_EPOCH:-0}
REMAIN=0
if [ "$EXPIRES_EPOCH" -gt 0 ]; then
  REMAIN=$((EXPIRES_EPOCH - $(date +%s)))
  if [ "$REMAIN" -le 0 ]; then
    echo "[moat] the injected credential expired before the box started; stopping"
    exit 0
  fi
fi
echo "[moat] codex runtime ready (pid $$)"
if [ "$EXPIRES_EPOCH" -gt 0 ]; then
  echo "[moat] the injected credential expires in \${REMAIN}s; the box stops then"
  sleep "$REMAIN"
  echo "[moat] injected credential expired; stopping the sandbox"
  exit 0
fi
exec sleep 2147483647
`
}

/** One non-interactive Codex turn. The prompt is an argument; the stream is JSONL. */
function codexExecBody(prompt: string): string {
  return `#!/bin/sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
cd ${SANDBOX_WORKDIR}
exec codex exec --json --skip-git-repo-check ${shellQuote(prompt)} </dev/null
`
}

/** Codex's own TUI, inside the box, on the terminal moat inherited. */
function codexTuiBody(prompt?: string): string {
  return `#!/bin/sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
cd ${SANDBOX_WORKDIR}
exec codex ${prompt && prompt.length > 0 ? shellQuote(prompt) : ""}
`
}

type CodexRunOptions = {
  env: Record<string, string>
  egress: EgressMode
  slirpBinary?: string
  egressRules?: string
  timeoutSeconds?: number
  showOutput?: boolean
  json?: boolean
}

/**
 * Drive one Codex turn and report it.
 *
 * Everything the host sees is the JSONL stream, parsed by `parseCodexEvents`; its usage
 * fields are normalised into the shape `lib/pricing.ts` prices, so the footer is the same
 * arithmetic as every other cost moat reports.
 */
async function runCodexTask(paths: EnvPaths, body: string, opts: CodexRunOptions): Promise<number> {
  const result = await runInSandbox(paths, body, {
    env: opts.env,
    egress: opts.egress,
    slirpBinary: opts.slirpBinary,
    egressRules: opts.egressRules,
    timeoutMs: (opts.timeoutSeconds ?? 2700) * 1000,
  })
  const turn = parseCodexEvents(result.output)
  if (opts.json) {
    log.emit({ ...turn, code: result.code, timedOut: result.timedOut })
    return result.code
  }
  for (const tool of turn.tools) {
    const failed = tool.status === "completed" && (tool.exitCode ?? 0) !== 0
    const marker = tool.status === "started" ? log.dim("…") : failed ? log.red("✗") : log.green("✓")
    const label = tool.kind === "command_execution" ? "" : log.dim(tool.kind + " ")
    log.info(`  ${marker} ${label}${log.dim(stripAnsi(tool.detail.split("\n")[0] ?? "").slice(0, 120))}`)
  }
  for (const message of turn.messages) log.info(`\n${stripAnsi(message).trimEnd()}`)
  for (const error of turn.errors) log.warn(stripAnsi(error))
  // Advisories are shown, dimmed, and never counted as failures in the footer.
  for (const notice of turn.notices) log.info(`  ${log.dim(stripAnsi(notice))}`)
  if (turn.usage) {
    const usage = {
      input: turn.usage.input,
      output: turn.usage.output,
      reasoning: turn.usage.reasoning,
      cacheRead: turn.usage.cached,
    }
    const modelID = opts.env.MOAT_MODEL_ID ?? ""
    const cost = computeCost(modelID, usage)
    const tokens = usage.input + usage.cacheRead + usage.output + usage.reasoning
    const money = cost.known ? `  ${log.dim(`${formatUSD(cost.usd)} ${cost.peak ? "peak" : "off-peak"}`)}` : ""
    log.info(`  ${log.dim(`${tokens} tokens`)}${money}  ${log.dim(describeCodexTurn(turn))}`)
  } else if (turn.tools.length > 0) {
    log.info(`  ${log.dim(describeCodexTurn(turn))}`)
  }
  if (result.timedOut) log.warn(`the turn was still running after ${opts.timeoutSeconds ?? 2700}s and was killed`)
  return result.code
}
async function main(): Promise<number> {
  // ~/.moat holds the credential store and the server password; make sure it is
  // 0700 before anything reads or writes there.
  ensureMoatHome()
  const argv = process.argv.slice(2)
  const command = argv[0]
  const rest = argv.slice(1)

  if (!command) {
    // `moat` on its own is the product: open a session in whatever directory you
    // are standing in. Piped or scripted, print help instead of hanging on stdin.
    if (process.stdin.isTTY === true) return await cmdUp([])
    process.stdout.write(HELP)
    return 0
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP)
    return 0
  }
  if (command === "--version" || command === "version") {
    process.stdout.write(`moat 0.0.1 (codex ${CODEX_VERSION}, alpine ${ALPINE_VERSION})\n`)
    return 0
  }
  // Parse once before dispatch: this is where a flag the command does not read is
  // refused (lib/flags.ts) instead of accepted and ignored, and where the three
  // global flags act. The command parses its own arguments again for its own use.
  if (Object.prototype.hasOwnProperty.call(COMMAND_FLAGS, command)) {
    let global: Parsed
    try {
      global = parse(rest, SPEC, command)
    } catch (error) {
      log.fail((error as Error).message)
    }
    if (global.flags.help === true) {
      process.stdout.write(HELP)
      return 0
    }
    if (global.flags.verbose === true) log.setVerbose(true)
    if (global.flags.quiet === true) log.setQuiet(true)
  }

  try {
    switch (command) {
      case "up":
        return await cmdUp(rest)
      case "fetch":
        return await cmdFetch(rest)
      case "apply":
        return await cmdApply(rest)
      case "take":
        return await cmdTake(rest)
      case "verify":
        return await cmdVerify(rest)
      case "run":
        // `moat run "task"` is `moat up "task"`. Same code, friendlier name.
        return await cmdUp(rest)
      case "down":
        return await cmdDown(rest)
      case "destroy":
        return await cmdDestroy(rest)
      case "status":
        return await cmdStatus(rest)
      case "snapshot":
        return await cmdSnapshot(rest)
      case "restore":
        return await cmdRestore(rest)
      case "logs":
        return await cmdLogs(rest)
      case "doctor":
        return await cmdDoctor(rest)
      case "shell":
        return await cmdShell(rest)
      case "exec":
        return await cmdExec(rest)
      case "models":
        return await cmdModels(rest)
      case "profiles":
        return await cmdProfiles(rest)
      default:
        log.fail(`unknown command: ${command}\n\n${HELP}`)
    }
  } catch (error) {
    log.fail((error as Error).message)
  }
  return 1
}

process.exitCode = await main()
