#!/usr/bin/env node
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { spawn } from "node:child_process"

import * as log from "../lib/log.ts"
import { hashTree } from "../lib/hash.ts"
import { probeHost, assertHostUsable, describeHost } from "../lib/host.ts"
import { envPaths, type EnvPaths } from "../lib/paths.ts"
import { ALPINE_VERSION, CURATED_TOOLS, EXCLUDED_TOOLS, OPENCODE_VERSION, SANDBOX_WORKDIR, UNADVERTISED_GAPS } from "../lib/pins.ts"
import { describeProviders, findProvider, providerIds, type ProviderSpec } from "../lib/providers.ts"
import { catalogModel, formatTokens, loadCatalog, type Catalog } from "../lib/catalog.ts"
import { describeProfiles, PROFILE_IDS, resolveProfiles, BASE_PACKAGES } from "../sandbox/profiles.ts"
import { detectProfiles, detectProviderFromEnv } from "../lib/detect.ts"
import { run, shellQuote, which } from "../lib/shell.ts"
import {
  envExists,
  initialState,
  listEnvs,
  readPassword,
  readState,
  writePassword,
  writeState,
  type EnvState,
} from "../sandbox/state.ts"
import {
  baselineSnapshot,
  destroyEnv,
  ensurePackages,
  listSnapshots,
  provisionEnv,
  restoreEnv,
  rootfsSizeBytes,
  snapshotEnv,
} from "../sandbox/rootfs.ts"
import {
  isRunning,
  runInSandbox,
  sandboxEnv,
  startSandbox,
  stopSandbox,
  unshareArgs,
  writeInnerScript,
  writeOuterScript,
} from "../sandbox/launcher.ts"
import { serveEntryScript } from "../sandbox/serve.ts"
import { installBundle } from "../bundle/install.ts"
import { TOOL_PRESETS, type ToolPreset } from "../bundle/render.ts"
import { runIsolationChecks, type IsolationReport } from "../sandbox/isolation.ts"
import {
  DEFAULT_TTL_SECONDS,
  INJECTED_ENV_NAMES,
  credentialRiskNotice,
  mint,
  refusedAutoCredential,
  ttlToSeconds,
  toSandboxEnv,
  type MintedCredential,
} from "../secrets/broker.ts"
import { copyIn, ensureSandboxRepo, hostState, isGitRepo, SANITIZED_GIT_ENV } from "../sync/copyin.ts"
import {
  applyBranch,
  commitSandboxWorktree,
  fetchBranch,
  listSandboxBranches,
  sandboxHead,
  sandboxWorktreeChanges,
  suggestBranch,
} from "../sync/copyout.ts"
import { connect, driveSession, listSessions, toolIds, waitForServer, authHeaders, baseUrl } from "./client.ts"
import { runRepl } from "./repl.ts"

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

type Spec = Record<string, "boolean" | "string" | "number">
type Parsed = { _: string[]; flags: Record<string, string | boolean | number> }

function parse(argv: string[], spec: Spec): Parsed {
  const flags: Parsed["flags"] = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--") {
      rest.push(...argv.slice(i + 1))
      break
    }
    if (!token.startsWith("-")) {
      rest.push(token)
      continue
    }
    const name = token.replace(/^--?/, "")
    const [key, inline] = name.includes("=") ? [name.slice(0, name.indexOf("=")), name.slice(name.indexOf("=") + 1)] : [name, undefined]
    const type = spec[key]
    if (!type) throw new Error(`unknown flag: ${token}`)
    if (type === "boolean") {
      flags[key] = inline === undefined ? true : inline !== "false"
      continue
    }
    const value = inline ?? argv[++i]
    if (value === undefined) throw new Error(`flag --${key} needs a value`)
    flags[key] = type === "number" ? Number(value) : value
  }
  return { _: rest, flags }
}

const SPEC: Spec = {
  help: "boolean",
  json: "boolean",
  verbose: "boolean",
  model: "string",
  provider: "string",
  profile: "string",
  profiles: "boolean",
  tools: "string",
  continue: "boolean",
  refresh: "boolean",
  "list-models": "boolean",
  "model-id": "string",
  "provider-base-url": "string",
  credential: "string",
  "credential-env": "string",
  "credential-ttl": "string",
  "no-credential": "boolean",
  port: "number",
  fresh: "boolean",
  sync: "boolean",
  "log-level": "string",
  prompt: "string",
  session: "string",
  agent: "string",
  all: "boolean",
  checkout: "boolean",
  name: "string",
  yes: "boolean",
  tail: "number",
  timeout: "number",
  "show-output": "boolean",
  "commit-worktree": "boolean",
  "no-detect": "boolean",
  "no-follow": "boolean",
  quiet: "boolean",
  "keep": "boolean",
}

function flag<T>(p: Parsed, key: string): T | undefined {
  const value = p.flags[key]
  return value === undefined ? undefined : (value as T)
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function resolveEnv(): EnvPaths {
  return envPaths(process.cwd())
}

function requireState(p: EnvPaths): EnvState {
  const state = readState(p)
  if (!state) log.fail(`no moat environment for ${p.projectDir}. Run \`moat up\` first.`)
  return state
}

function requireRunning(p: EnvPaths): { state: EnvState; password: string } {
  const state = requireState(p)
  if (!isRunning(state.pid)) {
    writeState(p, { ...state, status: "stopped", pid: null })
    log.fail(`the sandbox for ${p.projectDir} is not running. Run \`moat up\` first.`)
  }
  const password = readPassword(p)
  if (!password) log.fail("no server password on disk; run `moat up` again")
  return { state, password }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function randomPassword(): string {
  return crypto.randomBytes(24).toString("base64url")
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

/**
 * Decide which provider to use.
 *
 * Explicit flag wins. Otherwise moat looks for a credential it recognises and
 * infers the provider from it, but only from the names the provider actually
 * uses, and it says which one it picked rather than doing it silently.
 */
function resolveProvider(p: Parsed, state?: EnvState | null): ProviderSpec {
  const explicit = flag<string>(p, "provider")
  // A custom base URL only means anything for a custom endpoint, so it implies
  // `local` rather than silently pairing with whatever provider key happens to
  // be exported.
  if (!explicit && flag<string>(p, "provider-base-url")) return findProvider("local")!
  if (!explicit && !detectProviderFromEnv() && state?.provider) {
    // Nothing new exported, but this environment already knows what it used.
    // Typing the provider once should be enough.
    const remembered = findProvider(state.provider)
    if (remembered) {
      log.debug(`provider: ${remembered.id} (remembered from this environment)`)
      return remembered
    }
  }
  if (explicit) {
    const found = findProvider(explicit)
    if (!found) {
      log.fail(`unknown provider "${explicit}". Known: ${providerIds().join(", ")}\n\n${describeProviders()}`)
    }
    return found!
  }
  const detected = detectProviderFromEnv()
  if (detected) {
    log.debug(`provider: ${detected.provider} (from ${detected.envVar})`)
    return findProvider(detected.provider)!
  }
  // A custom endpoint with no credential yet still needs a provider shell.
  return findProvider("local")!
}

const PROVIDERS_ORDER = ["zai", "deepseek", "openai", "anthropic", "openrouter", "groq", "moonshot"]

type ResolvedModel = {
  providerID: string
  modelID: string
  model: string
  native: boolean
  meta: { context?: number; output?: number; toolCall?: boolean; reasoning?: boolean; attachment?: boolean } | undefined
}

async function resolveModel(
  spec: ProviderSpec,
  requested: string | undefined,
  catalog: Catalog | null,
  opts: { baseUrl?: string },
): Promise<ResolvedModel> {
  if (spec.id === "local" && !opts.baseUrl) {
    log.fail(
      `--provider local needs --provider-base-url (e.g. http://127.0.0.1:11434/v1 for Ollama).\n` +
        `Or pick a known provider: ${providerIds().filter((id) => id !== "local").join(", ")}`,
    )
  }
  const modelID = requested ?? spec.defaultModel
  if (!modelID) log.fail(`no model: pass --model <id>, or --provider-base-url for a custom endpoint`)

  const native = spec.native && spec.envVars.length > 0
  const catalogProvider = catalog?.get(spec.opencodeID)
  const known = catalogModel(catalog, spec.opencodeID, modelID!)

  if (catalog && native && catalogProvider && !known) {
    // Say so rather than failing: opencode would silently be unable to resolve it.
    log.warn(
      `${spec.opencodeID} does not define a model "${modelID}" in the models.dev catalog. ` +
        `moat will declare it as a custom OpenAI-compatible model instead. ` +
        `Known ids: ${catalogProvider.models.slice(0, 8).map((m) => m.id).join(", ")}…  (moat models ${spec.id})`,
    )
  }
  if (known && known.toolCall === false) {
    log.warn(`${spec.opencodeID}/${modelID} does not advertise tool calling; the agent will not be able to act.`)
  }

  const useNative = native && (known !== null || !catalog)
  const providerID = useNative ? spec.opencodeID : "moat"
  return {
    providerID,
    modelID: modelID!,
    model: `${providerID}/${modelID}`,
    native: useNative,
    meta: known
      ? { context: known.context, output: known.output, toolCall: known.toolCall, reasoning: known.reasoning, attachment: known.attachment }
      : undefined,
  }
}

function resolveToolPreset(p: Parsed): ToolPreset {
  const requested = (flag<string>(p, "tools") ?? "core").toLowerCase()
  if (requested !== "core" && requested !== "extended") {
    log.fail(`unknown --tools "${requested}". Use one of: ${Object.keys(TOOL_PRESETS).join(", ")}`)
  }
  return requested as ToolPreset
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

  const json = flag<boolean>(p, "json") ?? false
  const report: Record<string, unknown> = { project: paths.projectDir, envId: paths.id }

  let state = readState(paths)
  // Read the task once, before anything can return early. A task given to a
  // running sandbox used to be dropped on the floor by the reuse path below.
  const task = p._.join(" ").trim()

  const fresh = flag<boolean>(p, "fresh") ?? false
  const sync = flag<boolean>(p, "sync") ?? false
  const needsProvision = fresh || !envExists(paths) || !state

  let profileRequest = (flag<string>(p, "profile") ?? process.env.MOAT_PROFILES ?? "").trim()
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

  if (needsProvision) {
    log.step(
      `provisioning sandbox image (alpine ${ALPINE_VERSION} + opencode ${OPENCODE_VERSION}` +
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
    state = initialState(paths, { opencode: OPENCODE_VERSION, alpine: ALPINE_VERSION })
    writeState(paths, state)
    log.success(`image provisioned in ${ms(provision.totalMs)} (${provision.steps.map((s) => `${s.name} ${ms(s.ms)}`).join(", ")})`)
  }

  // A stopped sandbox may still be draining; make sure the recorded pid is gone.
  if (state!.pid && isRunning(state!.pid)) {
    log.info(`sandbox already running (pid ${state!.pid}) on port ${state!.port}`)
    const password = readPassword(paths)!
    const ready = await waitForServer(state!, password, { timeoutMs: 15000 })
    if (ready.ok) {
      if (task.length > 0) {
        const result = await driveTask(state!, password, task, {
          continueLast: flag<boolean>(p, "continue") ?? false,
          agent: flag<string>(p, "agent"),
          showOutput: flag<boolean>(p, "show-output") ?? false,
          timeoutSeconds: flag<number>(p, "timeout"),
        })
        if (json) log.emit(result)
        else {
          printTaskResult(result)
          printNextStep(paths, result.errors.length > 0 ? "the task reported errors" : null)
        }
        return result.errors.length > 0 ? 1 : 0
      }
      if (process.stdin.isTTY === true && !json && !flag<boolean>(p, "no-follow")) {
        return await runRepl({ paths, state: state!, password, showOutput: flag<boolean>(p, "show-output") ?? false })
      }
      if (json) log.emit({ ...report, status: "already-running", ...state })
      else printUpSummary(paths, state!, password, { coldStart: 0, reused: true, provisioned: false })
      return 0
    }
    log.warn("recorded sandbox pid is alive but the server is not answering; restarting it")
    await stopSandbox(state!.pid)
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
  if (!needsProvision && sandboxRepoExists && !sync && state?.baselineHostState) {
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

  if (drift?.changed && mustCopy) {
    log.warn(
      "the host project has changed since it was copied in, and the sandbox holds nothing that is not already " +
        "on the host. Re-copying it now.",
    )
  } else if (drift?.changed && !mustCopy) {
    const held = [
      drift.sandboxCommits > 0 ? `${drift.sandboxCommits} commit(s)` : null,
      drift.sandboxFiles > 0 ? `${drift.sandboxFiles} uncommitted file(s)` : null,
    ]
      .filter(Boolean)
      .join(" and ")
    log.warn(
      `the host project has changed since it was copied in, but the sandbox holds ${held} that the host does not ` +
        "have. The agent will work on the OLD copy. Run `moat fetch` (add --commit-worktree to include " +
        "uncommitted work) to keep it, or `moat up --sync` to discard it and re-copy.",
    )
  }

  if (mustCopy) {
    if (sync && fs.existsSync(path.join(paths.work, ".git"))) {
      const ahead = await countUnfetched(paths)
      if (ahead > 0) log.warn(`discarding ${ahead} commit(s) that exist only inside the sandbox`)
    }
    const copied = await copyIn(paths)
    await ensureSandboxRepo(paths)
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
  const provider = resolveProvider(p, state)
  const baseUrl = flag<string>(p, "provider-base-url") ?? provider.baseUrl
  const resolvedModel = await resolveModel(provider, flag<string>(p, "model"), catalog, { baseUrl })
  const toolPreset = resolveToolPreset(p)
  report.provider = { id: provider.id, opencodeID: resolvedModel.providerID, native: resolvedModel.native, label: provider.label }
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
  if (!flag<boolean>(p, "no-credential")) {
    credential = mint({
      literal: flag<string>(p, "credential"),
      envName: flag<string>(p, "credential-env"),
      provider: provider.id,
      baseUrl,
      model: resolvedModel.modelID,
      ttlSeconds,
      // Native providers get the credential under the name opencode looks for;
      // a custom endpoint gets it under moat's own name, which the rendered
      // provider block references as {env:MOAT_INJECTED_CREDENTIAL}.
      targetEnvVars: resolvedModel.native ? provider.envVars : [],
    })
    if (!credential) {
      const refused = refusedAutoCredential()
      if (refused) log.warn(refused)
      else {
        log.warn(
          "no credential found. moat will boot the sandbox, but the agent cannot call a model. " +
            "Provide one with --credential-env NAME, or create ~/.moat/credentials.json (chmod 600).",
        )
      }
    } else {
      log.warn(credentialRiskNotice(credential))
    }
  }

  // --- branch, bundle -------------------------------------------------------
  // Work on a dedicated branch so the user's own branch is untouched inside the
  // box too, and copy-out has one predictable ref to read.
  const branch = sessionBranch()
  let baseBranch: string | null = null
  if (fs.existsSync(path.join(paths.work, ".git"))) {
    baseBranch =
      (
        await run("git", ["-C", paths.work, "rev-parse", "--abbrev-ref", "HEAD"], {
          env: SANITIZED_GIT_ENV,
          allowFailure: true,
        })
      ).stdout.trim() || null
    const created = await run(
      "git",
      ["-C", paths.work, "checkout", "-q", "-B", branch],
      { env: SANITIZED_GIT_ENV, allowFailure: true },
    )
    if (created.code === 0) log.info(`agent branch: ${branch}`)
    else log.warn(`could not create ${branch} inside the sandbox; the agent will use the current branch`)
  }

  // The bundle is rendered and reinstalled on EVERY boot. The rootfs may have
  // come from the host image cache or from an environment created days ago,
  // either of which would otherwise keep running a stale plugin, which is
  // exactly how a shell.env fix silently failed to take effect once already.
  const bundleManifest = installBundle(paths.rootfs, {
    render: {
      provider,
      modelID: resolvedModel.modelID,
      baseUrl,
      preset: toolPreset,
      modelMeta: resolvedModel.meta,
    },
    brief: {
      provider: provider.label,
      model: resolvedModel.model,
      branch,
      profiles: resolvedProfiles.profiles,
      installedPackages: resolvedProfiles.profiles.length > 0 ? resolvedProfiles.packages : BASE_PACKAGES,
      hasCredential: Boolean(credential),
    },
    installedPackages: resolvedProfiles.profiles.length > 0 ? resolvedProfiles.packages : BASE_PACKAGES,
  })
  report.bundle = { curated: bundleManifest.curated, excluded: bundleManifest.excluded, preset: bundleManifest.preset }

  // Fail before booting, not after. Asking for a task with no model means the
  // box starts, the turn errors immediately, and the user is left reading a
  // session id. Cheaper to say so now.
  if (task.length > 0 && !credential) {
    log.fail(
      "no credential, so the agent has no model to call. Either:\n" +
        `  export ZHIPU_API_KEY=...     then  moat run --provider zai "..."\n` +
        `  export DEEPSEEK_API_KEY=...  then  moat run --provider deepseek "..."\n` +
        `  export OPENAI_API_KEY=...    then  moat run --provider openai "..."\n` +
        `  or name one explicitly:      moat run --credential-env MY_KEY "..."\n` +
        "  or point at any OpenAI-compatible endpoint:  moat run --provider-base-url http://localhost:11434/v1 --model llama3 \"...\"",
    )
  }

  // --- boot -----------------------------------------------------------------
  const port = flag<number>(p, "port") ?? (await freePort())
  const password = randomPassword()
  writePassword(paths, password)

  const entry = serveEntryScript({
    port,
    logLevel: flag<string>(p, "log-level") as "INFO" | undefined,
    credentialTtlSeconds: credential ? credential.ttlSeconds : null,
  })

  const sandboxEnvVars: Record<string, string> = {
    OPENCODE_SERVER_PASSWORD: password,
    MOAT_PORT: String(port),
    ...(credential ? toSandboxEnv(credential) : {}),
    ...extraSandboxEnv(),
  }

  const bootStart = Date.now()
  const sandbox = startSandbox(paths, entry, sandboxEnvVars)
  state = {
    ...(state as EnvState),
    status: "running",
    pid: sandbox.pid,
    port,
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
        }
      : null,
  }
  writeState(paths, state)
  log.step(`sandbox booted (pid ${sandbox.pid}, port ${port}); waiting for opencode serve`)

  const ready = await waitForServer(state, password, { timeoutMs: flag<number>(p, "timeout") ?? 90000 })
  const bootMs = Date.now() - bootStart
  if (!ready.ok) {
    const tail = tailFile(path.join(paths.logs, "sandbox.log"), 40)
    await stopSandbox(sandbox.pid)
    writeState(paths, { ...state, status: "stopped", pid: null })
    log.fail(`opencode serve did not come up (${ready.detail}).\n--- sandbox log ---\n${tail}`)
  }

  state.lastBootMs = bootMs
  writeState(paths, state)

  // `moat up "fix the tests"` and `moat run "fix the tests"` are the same thing:
  // bringing up a box you are not going to use is not a step worth having.
  // At a terminal, a task is the first line of a conversation rather than the
  // whole of one: start it, then stay so it can be steered while it runs.
  const interactive = process.stdin.isTTY === true && !json && !flag<boolean>(p, "no-follow")
  if (task.length > 0 && interactive) {
    return await runRepl({
      paths,
      state,
      password,
      firstMessage: task,
      showOutput: flag<boolean>(p, "show-output") ?? false,
    })
  }

  if (task.length > 0) {
    const result = await driveTask(state, password, task, {
      continueLast: flag<boolean>(p, "continue") ?? false,
      agent: flag<string>(p, "agent"),
      showOutput: flag<boolean>(p, "show-output") ?? false,
      timeoutSeconds: flag<number>(p, "timeout"),
    })
    if (json) log.emit(result)
    else {
      printTaskResult(result)
      printNextStep(paths, result.errors.length > 0 ? "the task reported errors" : null)
    }
    return result.errors.length > 0 ? 1 : 0
  }

  report.status = "running"
  report.port = port
  report.pid = sandbox.pid
  report.bootMs = bootMs
  report.totalMs = Date.now() - started
  report.readyCheck = ready.detail
  report.credential = credential
    ? { provider: credential.provider, fingerprint: credential.fingerprint, expiresAt: credential.expiresAt, source: credential.source }
    : null
  report.host = describeHost(host)
  report.credentialsInSandboxEnv = Object.keys(sandboxEnvVars).sort()

  if (json) log.emit(report)
  else
    printUpSummary(paths, state, password, {
      coldStart: Date.now() - started,
      reused: false,
      provisioned: needsProvision,
      bootMs,
    })

  return 0
}

/**
 * Escape hatch for experiments: extra KEY=VALUE pairs to place in the sandbox
 * environment. Names are restricted to the OPENCODE_/MOAT_ prefixes so this can
 * never become a channel that forwards host environment into the box, the
 * property the isolation test checks for.
 */
function extraSandboxEnv(): Record<string, string> {
  const raw = process.env.MOAT_SANDBOX_ENV
  if (!raw) return {}
  const result: Record<string, string> = {}
  for (const pair of raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
    const index = pair.indexOf("=")
    if (index === -1) continue
    const key = pair.slice(0, index)
    if (!/^(OPENCODE_|MOAT_)/.test(key)) {
      log.warn(`ignoring MOAT_SANDBOX_ENV entry ${key}: only OPENCODE_/MOAT_ prefixed names may enter the sandbox`)
      continue
    }
    result[key] = pair.slice(index + 1)
  }
  return result
}

/**
 * How many commits exist in the sandbox that the host cannot already reach.
 *
 * "Cannot reach" means unreachable from *any* host ref, including the
 * `refs/moat/*` refs that `moat fetch` creates. That distinction matters: once
 * the user has fetched, the work is safely on the host and re-copying the
 * project is lossless, so moat can do it automatically instead of nagging.
 */
async function countUnfetched(paths: EnvPaths): Promise<number> {
  const head = await sandboxHead(paths)
  if (!head) return 0

  // If the sandbox's head is already present on the host, ask git precisely.
  const known = await run("git", ["-C", paths.projectDir, "cat-file", "-e", `${head}^{commit}`], {
    env: SANITIZED_GIT_ENV,
    allowFailure: true,
  })
  if (known.code === 0) {
    const count = await run("git", ["-C", paths.projectDir, "rev-list", "--count", head, "--not", "--all"], {
      env: SANITIZED_GIT_ENV,
      allowFailure: true,
    })
    return Number.parseInt(count.stdout.trim(), 10) || 0
  }

  // Otherwise the sandbox has commits the host has never seen. Fall back to
  // counting them relative to the shared base.
  const base = await run("git", ["-C", paths.projectDir, "rev-parse", "HEAD"], {
    env: SANITIZED_GIT_ENV,
    allowFailure: true,
  })
  if (base.code !== 0) return 0
  const count = await run(
    "git",
    ["-C", paths.work, "rev-list", "--count", `${base.stdout.trim()}..${head}`],
    { env: SANITIZED_GIT_ENV, allowFailure: true },
  )
  return Number.parseInt(count.stdout.trim(), 10) || 0
}

/**
 * What to do next, said once, at the end of whatever just happened.
 *
 * Every command that changes state ends here, so the user never has to hold the
 * lifecycle in their head to know their next move.
 */
function printNextStep(paths: EnvPaths, problem: string | null): void {
  log.info("")
  if (problem) log.info(`${log.yellow("!")} ${problem}`)
  log.info(`  ${log.bold("moat take")}    ${log.dim("review and apply what the agent did")}`)
  log.info(`  ${log.bold("moat run")}     ${log.dim('give it another task, e.g. moat run "add tests"')}`)
  log.info(`  ${log.bold("moat down")}    ${log.dim("stop the box; nothing is lost")}`)
  log.info(`  ${log.dim(`(project ${paths.projectDir})`)}`)
}

function printUpSummary(
  paths: EnvPaths,
  state: EnvState,
  password: string,
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
  log.info(`  opencode   http://127.0.0.1:${state.port}  (basic auth user "opencode")`)
  log.info(`  password   ${password}`)
  log.info(`  workspace  ${SANDBOX_WORKDIR} (inside the sandbox)`)
  if (state.credential) {
    log.info(`  credential ${state.credential.provider} ${state.credential.fingerprint} expires ${state.credential.expiresAt}`)
  }
  log.info("")
  log.info(`  next: ${log.bold("moat attach")}   ${log.dim("drive a session")}`)
  log.info(`        ${log.bold("moat fetch")}    ${log.dim("pull the agent's branch onto the host")}`)
  log.info(`        ${log.bold("moat down")}     ${log.dim("stop the sandbox (state is kept)")}`)
}

// ---------------------------------------------------------------------------
// moat attach
// ---------------------------------------------------------------------------

async function cmdAttach(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  const { state, password } = requireRunning(paths)
  const prompt = flag<string>(p, "prompt")

  if (!prompt) {
    // moat's own interactive session. This used to exec opencode's TUI, which
    // meant an interactive session was impossible unless opencode was also
    // installed on the host. The sandbox already runs the server; the CLI is a
    // client of it, so the dependency was never necessary.
    return await runRepl({
      paths,
      state,
      password,
      showOutput: flag<boolean>(p, "show-output") ?? false,
      sessionID: flag<string>(p, "session"),
    })
  }

  const result = await driveTask(state, password, prompt, {
    sessionID: flag<string>(p, "session"),
    continueLast: flag<boolean>(p, "continue") ?? false,
    agent: flag<string>(p, "agent"),
    modelID: flag<string>(p, "model-id"),
    showOutput: flag<boolean>(p, "show-output") ?? false,
    timeoutSeconds: flag<number>(p, "timeout"),
  })

  if (flag<boolean>(p, "json")) log.emit(result)
  else printTaskResult(result)
  return result.errors.length > 0 ? 1 : 0
}

/**
 * Run one prompt inside a running sandbox and report it as it happens.
 *
 * Shared by `moat attach --prompt` and `moat run`, which is the whole point:
 * "start the box" and "do this task" are the same operation with one step
 * skipped, so they should not be two commands the user has to discover.
 */
async function driveTask(
  state: EnvState,
  password: string,
  prompt: string,
  opts: {
    sessionID?: string
    continueLast?: boolean
    agent?: string
    modelID?: string
    showOutput?: boolean
    timeoutSeconds?: number
  },
): Promise<Awaited<ReturnType<typeof driveSession>>> {
  const client = await connect(state, password, SANDBOX_WORKDIR)

  // Sessions live in the rootfs, so they survive `moat down` / `moat up`.
  let sessionID = opts.sessionID
  if (!sessionID && opts.continueLast) {
    const sessions = await listSessions(client)
    if (sessions.length > 0) {
      sessionID = sessions[0]!.id
      log.info(`continuing session ${sessionID}${sessions[0]!.title ? ` (${sessions[0]!.title})` : ""}`)
    } else {
      log.warn("--continue given but this environment has no sessions yet; starting a new one")
    }
  }

  const modelRef = state.model ?? "moat/model"
  const [providerID = "moat", ...rest] = modelRef.split("/")

  let wrote = false
  const result = await driveSession(client, {
    sessionID,
    prompt,
    providerID,
    modelID: opts.modelID ?? rest.join("/") ?? "model",
    agent: opts.agent,
    onEvent: (line) => process.stderr.write(`${line}\n`),
    onDelta: (chunk) => {
      wrote = true
      process.stderr.write(chunk)
    },
    showOutput: opts.showOutput,
    timeoutMs: (opts.timeoutSeconds ?? 2700) * 1000,
  })
  if (wrote) process.stderr.write("\n")
  return result
}

function printTaskResult(result: { sessionID: string; toolCalls: { tool: string; status: string }[] }): void {
  const failed = result.toolCalls.filter((t) => t.status === "error").length
  log.info("")
  log.info(
    `${log.dim("session")} ${result.sessionID}   ` +
      `${result.toolCalls.length} tool call(s)${failed > 0 ? log.red(`, ${failed} failed`) : ""}`,
  )
}

async function ensureHostOpencode(): Promise<string | null> {
  if (process.env.MOAT_HOST_OPENCODE) return process.env.MOAT_HOST_OPENCODE
  const onPath = await which("opencode")
  if (onPath) return onPath
  return null
}

// ---------------------------------------------------------------------------
// moat fetch / apply
// ---------------------------------------------------------------------------

async function cmdFetch(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  requireState(paths)
  if (!(await isGitRepo(paths.projectDir))) {
    log.fail(`${paths.projectDir} is not a git repository; there is nowhere to fetch into`)
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
      for (const line of dirty.slice(0, 10)) log.info(`    ${line}`)
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
      log.fail(`no branch "${branch}" in the sandbox. Available: ${branches.map((b) => b.name).join(", ")}`)
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
    log.success(`fetched ${result.branch} -> ${result.hostRef} (${result.sha.slice(0, 12)})`)
    log.info(`  ${result.commits} commit(s) reachable, HEAD ${result.headBefore?.slice(0, 12)} -> ${result.headAfter?.slice(0, 12)}`)
    for (const commit of result.commitsFetched.slice(0, 10)) {
      log.info(`    ${commit.sha.slice(0, 12)}  ${commit.subject}`)
    }
  }
  log.info("")
  log.info(`  the host working tree was recomputed and is ${worktreeUntouched ? log.green("byte-identical") : log.red("CHANGED")}`)
  log.info(`  inspect with:  git log ${results[0]!.hostRef}`)
  log.info(`  apply with:    moat apply ${results[0]!.branch}${log.dim("  (or --checkout)")}`)
  return worktreeUntouched ? 0 : 1
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
  requireState(paths)
  if (!isGitRepo(paths.projectDir)) log.fail(`${paths.projectDir} is not a git repository; nothing to take into`)

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
    log.info(`  ${log.dim(commit.sha.slice(0, 10))}  ${commit.subject}`)
  }

  const changed = await run("git", ["-C", paths.projectDir, "diff", "--stat", result.headBefore ?? "HEAD", result.hostRef], {
    env: SANITIZED_GIT_ENV,
    allowFailure: true,
  })
  if (changed.stdout.trim()) {
    log.info("")
    log.info(changed.stdout.trimEnd())
  }

  log.info("")
  log.info(`  your working tree is ${before.digest === after.digest ? log.green("untouched") : log.red("CHANGED")}`)
  log.info(`  review:  git log ${result.hostRef}`)
  log.info(`  accept:  moat apply ${target} --checkout`)
  log.info(`  reject:  git update-ref -d ${result.hostRef}`)
  return before.digest === after.digest ? 0 : 1
}

async function cmdApply(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  requireState(paths)
  const branch = p._[0]
  if (!branch) log.fail("usage: moat apply <branch> [--checkout] [--name <local-branch>]")
  const result = await applyBranch(paths, branch, {
    name: flag<string>(p, "name"),
    checkout: flag<boolean>(p, "checkout") ?? false,
  })
  log.success(`branch ${result.branch} -> ${result.ref}`)
  if (!flag<boolean>(p, "checkout")) log.info(`  checkout with: git checkout ${result.branch}`)
  return 0
}

// ---------------------------------------------------------------------------
// down / destroy / status / snapshot / restore / logs
// ---------------------------------------------------------------------------

async function cmdDown(argv: string[]): Promise<number> {
  parse(argv, SPEC) // validates flags; `down` takes no options of its own
  const paths = resolveEnv()
  const state = requireState(paths)
  if (!state.pid || !isRunning(state.pid)) {
    writeState(paths, { ...state, status: "stopped", pid: null })
    log.info("sandbox is not running")
    return 0
  }
  if (await stopSandbox(state.pid)) {
    writeState(paths, { ...state, status: "stopped", pid: null })
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
  const state = readState(paths)
  if (state?.pid && isRunning(state.pid)) {
    if (!flag<boolean>(p, "yes")) {
      log.fail("sandbox is running. Stop it first, or pass --yes to destroy it while running.")
    }
    await stopSandbox(state.pid)
  }
  const removed = destroyEnv(paths.projectDir)
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
      const state = readState(env)
      if (!state) continue
      rows.push({
        id: state.id,
        project: state.projectDir,
        status: isRunning(state.pid) ? "running" : "stopped",
        port: state.port,
        pid: state.pid,
        credential: state.credential?.expiresAt ?? null,
      })
    }
    if (flag<boolean>(p, "json")) log.emit(rows)
    else if (rows.length === 0) log.info("no moat environments")
    else for (const row of rows) log.info(`${row.status.padEnd(8)} ${row.id}  ${row.project}`)
    return 0
  }

  const state = readState(paths)
  if (!state) log.fail(`no moat environment for ${paths.projectDir}. Run \`moat up\` first.`)
  const running = isRunning(state!.pid)
  if (running !== (state!.status === "running")) {
    state!.status = running ? "running" : "stopped"
    if (!running) state!.pid = null
    writeState(paths, state!)
  }
  const snapshots = await listSnapshots(paths)
  const payload = {
    ...state!,
    envDir: paths.dir,
    rootfsDir: paths.rootfs,
    running,
    url: running ? baseUrl(state!) : null,
    snapshots: snapshots.map((s) => s.name),
    rootfsBytes: await rootfsSizeBytes(paths),
    sandboxBranches: fs.existsSync(path.join(paths.work, ".git")) ? await listSandboxBranches(paths) : [],
  }
  if (flag<boolean>(p, "json")) log.emit(payload)
  else {
    log.info(`project      ${state!.projectDir}`)
    log.info(`env          ${paths.dir}`)
    log.info(`status       ${running ? log.green("running") : log.yellow("stopped")}`)
    if (running) log.info(`endpoint     ${baseUrl(state!)}`)
    if (state!.pid) log.info(`pid          ${state!.pid}`)
    log.info(`opencode     ${state!.opencodeVersion} / alpine ${state!.alpineVersion}`)
    if (state!.model) log.info(`model        ${state!.model}${state!.provider ? ` (${state!.provider})` : ""}`)
    if (state!.branch) log.info(`branch       ${state!.branch}`)
    if (state!.profiles && state!.profiles.length > 0) log.info(`profiles     ${state!.profiles.join(", ")}`)
    log.info(`rootfs       ${human(payload.rootfsBytes)}`)
    if (state!.credential) {
      const remaining = Math.round((new Date(state!.credential.expiresAt).getTime() - Date.now()) / 1000)
      const note = remaining <= 0 ? log.red(" (EXPIRED, the sandbox watchdog stops the agent)") : ""
      log.info(`credential   ${state!.credential.provider} ${state!.credential.fingerprint} expires in ${remaining}s${note}`)
    }
    log.info(`snapshots    ${snapshots.map((s) => s.name).join(", ") || "none"}`)
    if (payload.sandboxBranches.length > 0) {
      log.info(`branches     ${payload.sandboxBranches.map((b) => `${b.name}${b.current ? "*" : ""}`).join(", ")}`)
    }
  }
  return 0
}

async function cmdSnapshot(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  requireState(paths)
  const name = p._[0] ?? `snap-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const result = await snapshotEnv(paths, name)
  log.success(`snapshot ${name} (${human(result.bytes)}) -> ${result.file}`)
  return 0
}

async function cmdRestore(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  const state = requireState(paths)
  const name = p._[0]
  if (!name) log.fail(`usage: moat restore <name>\navailable: ${(await listSnapshots(paths)).map((s) => s.name).join(", ")}`)

  // Restoring replaces the rootfs directory. A running sandbox has that
  // directory bound as its root, so it would keep serving the *deleted* image
  // while the host sees the new one. Refuse rather than silently produce that.
  if (state.pid && isRunning(state.pid)) {
    if (!flag<boolean>(p, "yes")) {
      log.fail(
        `the sandbox is running (pid ${state.pid}). Restoring its rootfs underneath it would leave it serving a ` +
          `deleted image. Stop it first (\`moat down\`) or pass --yes to stop it as part of the restore.`,
      )
    }
    await stopSandbox(state.pid)
    writeState(paths, { ...state, status: "stopped", pid: null })
    log.info(`stopped sandbox pid ${state.pid} before restoring`)
  }
  await restoreEnv(paths, name!)
  log.success(`restored rootfs snapshot ${name} (the project copy in /work was preserved)`)
  return 0
}

function tailFile(file: string, lines: number): string {
  if (!fs.existsSync(file)) return "(no log)"
  const content = fs.readFileSync(file, "utf8").split("\n")
  return content.slice(-lines).join("\n")
}

async function cmdLogs(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  requireState(paths)
  const which_ = p._[0] ?? "sandbox"
  const file =
    which_ === "audit" ? path.join(paths.auditDir, "tools.jsonl") : path.join(paths.logs, `${which_}.log`)
  log.info(tailFile(file, flag<number>(p, "tail") ?? 80))
  return 0
}

// ---------------------------------------------------------------------------
// moat doctor / shell / env
// ---------------------------------------------------------------------------

async function cmdDoctor(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const host = await probeHost()
  const paths = resolveEnv()
  const out: Record<string, unknown> = { host }

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

  const state = readState(paths)
  if (!state) {
    log.info("")
    log.info(`no environment for ${paths.projectDir}; run \`moat up\` to create one, then \`moat doctor\` again`)
    if (flag<boolean>(p, "json")) log.emit(out)
    return host.problems.length === 0 ? 0 : 1
  }

  let isolation: IsolationReport | null = null
  if (envExists(paths)) {
    log.step("running in-sandbox isolation checks")
    isolation = await runIsolationChecks(paths, {
      hostHome: process.env.HOME ?? "",
      injectedVarNames: [...INJECTED_ENV_NAMES, "OPENCODE_SERVER_PASSWORD"],
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
  requireState(paths)
  const command = p._
  if (command.length === 0) log.fail("usage: moat exec -- <command> [args...]")
  const body = `#!/bin/sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
cd ${SANDBOX_WORKDIR}
exec ${command.map((arg) => shellQuote(arg)).join(" ")}
`
  const result = await runInSandbox(paths, body, { onOutput: (chunk) => process.stdout.write(chunk) })
  return result.code
}

async function cmdShell(argv: string[]): Promise<number> {
  parse(argv, SPEC) // validates flags; `shell` takes no options of its own
  const paths = resolveEnv()
  requireState(paths)
  const body = `#!/bin/sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
cd ${SANDBOX_WORKDIR}
echo "[moat] sandbox shell, this is inside the box, not your host"
exec /bin/bash -l
`
  writeInnerScript(paths, body)
  const boot = writeOuterScript(paths)
  return await new Promise<number>((resolve, reject) => {
    const proc = spawn("unshare", unshareArgs(boot), { stdio: "inherit", env: sandboxEnv() })
    proc.on("error", reject)
    proc.on("close", (code) => resolve(code ?? 0))
  })
}

async function cmdEnv(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  const { state, password } = requireRunning(paths)
  const payload = {
    url: baseUrl(state),
    username: "opencode",
    password,
    directory: SANDBOX_WORKDIR,
    authorization: authHeaders(password).Authorization,
    pid: state.pid,
    envDir: paths.dir,
    opencode: state.opencodeVersion,
  }
  if (flag<boolean>(p, "json")) log.emit(payload)
  else {
    log.info(`url           ${payload.url}`)
    log.info(`username      ${payload.username}`)
    log.info(`password      ${payload.password}`)
    log.info(`directory     ${payload.directory}`)
    log.info(`authorization ${payload.authorization}`)
  }
  return 0
}

/** `moat models [provider]`, what the catalog actually offers, not a stale list. */
async function cmdModels(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const catalog = await loadCatalog({ refresh: flag<boolean>(p, "refresh") ?? false })
  if (!catalog) log.fail("could not load the models.dev catalog and there is no cached copy")

  const requested = p._[0]
  const specs = requested
    ? [findProvider(requested) ?? log.fail(`unknown provider "${requested}". Known: ${providerIds().join(", ")}`)]
    : (["zai", "deepseek", "openai"] as const).map((id) => findProvider(id)!)

  const payload: Record<string, unknown> = {}
  for (const spec of specs) {
    const entry = catalog!.get(spec.opencodeID)
    if (!entry) {
      payload[spec.id] = { error: `not in the catalog (opencodeID=${spec.opencodeID})` }
      if (!flag<boolean>(p, "json")) log.info(`${spec.id}: not in the catalog; use --provider-base-url`)
      continue
    }
    const models = [...entry.models].sort((a, b) => (b.context ?? 0) - (a.context ?? 0))
    payload[spec.id] = { id: entry.id, env: entry.envVars, api: entry.api, models }
    if (flag<boolean>(p, "json")) continue
    log.info("")
    log.info(`${log.bold(spec.label)}  (--provider ${spec.id})  env=${entry.envVars.join(" | ") || "n/a"}`)
    if (entry.api) log.info(`  endpoint ${entry.api}`)
    log.info(`  ${"model".padEnd(38)} ${"context".padStart(7)} ${"output".padStart(7)}  tools`)
    for (const model of models.slice(0, 30)) {
      const isDefault = model.id === spec.defaultModel ? log.green(" *") : "  "
      log.info(
        `${isDefault}${model.id.padEnd(36)} ${formatTokens(model.context).padStart(7)} ` +
          `${formatTokens(model.output).padStart(7)}  ${model.toolCall ? "yes" : log.yellow("NO")}`,
      )
    }
    if (models.length > 30) log.info(`  … and ${models.length - 30} more`)
    log.info(`  ${log.dim("* = moat's default. Usage: moat up --provider " + spec.id + " --model <id>")}`)
  }
  if (flag<boolean>(p, "json")) log.emit(payload)
  return 0
}

/** `moat profiles`, what the sandbox can be given. */
async function cmdProfiles(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  if (flag<boolean>(p, "json")) {
    log.emit({ base: BASE_PACKAGES, profiles: resolveProfiles([]).profiles.length ? [] : undefined, ...({} as object) })
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

async function cmdTools(argv: string[]): Promise<number> {
  const p = parse(argv, SPEC)
  const paths = resolveEnv()
  const { state, password } = requireRunning(paths)
  const client = await connect(state, password, SANDBOX_WORKDIR)

  // Two different lists, and the difference between them is the whole point:
  //
  //  - `registry` is what the server's tool registry holds. It is NOT what the
  //    model sees; it is everything opencode knows about.
  //  - `bundle` is what the moat plugin loaded and recorded at config time.
  //  - the authoritative model-facing list is captured from the provider side
  //    (see docs/VERIFICATION.md): opencode sends its tool definitions in the
  //    inference request, so the mock provider records them verbatim.
  const registry = (await toolIds(client)).sort()
  const bundleReport = readBundleReport(paths)
  const curatedPresent = registry.filter((id) => CURATED_TOOLS.includes(id as never))

  const payload = {
    registry,
    bundle: bundleReport,
    curated: CURATED_TOOLS,
    curatedPresent,
    excluded: EXCLUDED_TOOLS,
    curatedButNotAdvertised: CURATED_TOOLS.filter((id) => !registry.includes(id as never)),
    /** Known, documented opencode limitation: these cannot be pruned from the list. */
    unprunableByOpencode: UNADVERTISED_GAPS.filter((id) => registry.includes(id as never)),
    advisory: "registry is pre-materialization; the model-facing list is what the provider receives and is measured in docs/VERIFICATION.md",
  }

  if (flag<boolean>(p, "json")) {
    log.emit(payload)
    return 0
  }

  log.info(`${log.bold("bundle")} (from the plugin's config-time record)`)
  log.info(`  curated    ${CURATED_TOOLS.join(", ")}`)
  log.info(`  excluded   ${EXCLUDED_TOOLS.join(", ")}`)
  log.info(`  omissions confirmed by opencode: ${(bundleReport?.toolOmissions ?? []).join(", ") || "(plugin record missing)"}`)
  if ((bundleReport?.curationGaps ?? []).length > 0) {
    log.warn(`  curation gaps reported by the plugin: ${bundleReport!.curationGaps!.join(", ")}`)
  }
  log.info("")
  log.info(`${log.bold("registry")} (everything opencode knows about, NOT what the model sees)`)
  for (const id of registry) {
    const inBundle = CURATED_TOOLS.includes(id as never)
    log.info(`  ${inBundle ? log.green("+") : log.dim("-")} ${id}`)
  }
  if (payload.curatedButNotAdvertised.length > 0) {
    log.info("")
    log.info(
      `  ${log.dim("declared in the bundle but gated by opencode for this model:")} ${payload.curatedButNotAdvertised.join(", ")}`,
    )
    log.info(
      `  ${log.dim("(apply_patch is only offered for gpt-* models; see packages/opencode/src/tool/registry.ts)")}`,
    )
  }
  if (payload.unprunableByOpencode.length > 0) {
    log.info("")
    log.warn(
      `opencode 1.18.31 cannot stop advertising: ${payload.unprunableByOpencode.join(", ")}. ` +
        `The bundle refuses to execute them (docs/UPSTREAM-CANDIDATES.md).`,
    )
  }
  return 0
}

/**
 * The bundle as installed in the rootfs, plus the plugin's config-time record if
 * a session has already caused the plugin to load. The installed config is the
 * authoritative declaration; the plugin record proves opencode agreed with it.
 */
function readBundleReport(paths: EnvPaths): {
  curated?: string[]
  excludedFromBuiltins?: string[]
  toolOmissions?: string[]
  curationGaps?: string[]
  permission?: Record<string, string>
  source?: string
} | null {
  const installed = path.join(paths.rootfs, "usr/local/share/moat/opencode.json")
  const pluginReport = path.join(paths.auditDir, "bundle.json")
  let declared: Record<string, boolean> = {}
  try {
    declared = (JSON.parse(fs.readFileSync(installed, "utf8")) as { tools?: Record<string, boolean> }).tools ?? {}
  } catch {
    return null
  }
  const omissions = Object.entries(declared)
    .filter(([, enabled]) => enabled === false)
    .map(([name]) => name)
  const base = {
    excludedFromBuiltins: omissions,
    toolOmissions: omissions,
    source: "installed bundle config",
  }
  if (!fs.existsSync(pluginReport)) return base
  try {
    const live = JSON.parse(fs.readFileSync(pluginReport, "utf8")) as Record<string, unknown>
    return { ...base, ...live, source: `${installed} + ${pluginReport}` } as ReturnType<typeof readBundleReport>
  } catch {
    return base
  }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const HELP = `moat — run an AI coding agent in a disposable sandbox. Your machine is never touched.

Usage: moat <command> [options]

  moat run "<task>"      boot if needed, do the task, stream the work
  moat take              review what the agent did, and apply it if you want
  moat down              stop the sandbox; nothing is lost
  moat status            what is running, on which model, with how much time left

That is the whole loop. Everything below exists but you should not need it.

Attaching to a running box
  moat run "<task>"      give it another task
  moat attach            open opencode's own TUI against the running box
  moat shell             a plain shell inside the sandbox
  moat exec -- <cmd>     run one command inside the sandbox

Branches and history
  moat fetch [branch]    bring the agent's branch across into refs/moat/*
                         --commit-worktree  also commit anything left uncommitted
  moat take [branch]     fetch, show, and offer to apply
  moat apply <branch>    create a local branch from a fetched ref (--checkout to switch)

The environment
  moat up [task]         start it without a task; --profile, --fresh, --sync live here
  moat profiles          toolchain profiles the sandbox can be given
  moat models [provider] what the model catalog offers, with context windows
  moat destroy           delete this project's environment and snapshots
  moat snapshot [name]   save the rootfs; moat restore <name> brings it back

Diagnostics
  moat doctor            host support, 14 isolation checks, and the measured exposures
  moat tools             the declared tools, and what opencode actually offers
  moat env               connection details (url, password, auth header)
  moat logs [sandbox|audit]
  moat version

Options that apply to up/run
  --provider NAME        zai | deepseek | openai | anthropic | openrouter | groq | moonshot | local
  --model ID             default per provider; see: moat models
  --profile LIST         node,python,cc,go,rust,java,db,net,browser,cli,full
                         (auto-detected from the project if you do not say)
  --no-detect            do not guess a profile from the project
  --tools core|extended  core = 8 coding tools (default); extended adds webfetch + subagents
  --provider-base-url URL  any OpenAI-compatible endpoint, e.g. Ollama
  --credential-env NAME  host env var holding the key   --credential-ttl 4h
  --continue             continue the last session instead of starting a new one
  --show-output          print each tool's output as it runs
  --json                 machine-readable output on stdout
  --verbose              verbose diagnostics on stderr

Docs: docs/SPEC.md, docs/VERIFICATION.md
`

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const rest = argv.slice(1)

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP)
    return 0
  }
  if (command === "--version" || command === "version") {
    process.stdout.write(`moat 0.0.1 (opencode ${OPENCODE_VERSION}, alpine ${ALPINE_VERSION})\n`)
    return 0
  }
  if (rest.includes("--verbose")) process.env.MOAT_VERBOSE = "1"

  try {
    switch (command) {
      case "up":
        return await cmdUp(rest)
      case "attach":
        return await cmdAttach(rest)
      case "fetch":
        return await cmdFetch(rest)
      case "apply":
        return await cmdApply(rest)
      case "take":
        return await cmdTake(rest)
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
      case "env":
        return await cmdEnv(rest)
      case "tools":
        return await cmdTools(rest)
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
