/**
 * moat's curated tool bundle, as an opencode plugin.
 *
 * This file runs INSIDE the sandbox, imported by opencode itself. It is plain
 * ESM JavaScript on purpose: the rootfs ships no build toolchain, and the
 * bundle must never need one.
 *
 * It does three things:
 *
 *  1. CURATION, ENFORCED AT THE TOOL BOUNDARY.
 *
 *     opencode's built-ins are a static list
 *     (packages/core/src/tool/builtins.ts): apply_patch, bash, edit, glob,
 *     grep, question, read, skill, todowrite, webfetch, websearch, write.
 *     moat's bundle keeps a subset.
 *
 *     opencode 1.18.31 offers no supported way to remove a built-in from the
 *     list it advertises to the model: the model-facing list is built from the
 *     static `builtin` array in packages/opencode/src/tool/registry.ts with no
 *     permission filter applied (packages/opencode/src/session/tools.ts:92),
 *     and `tools: {x: false}` compiles only to a permission rule
 *     (packages/opencode/src/config/config.ts:567). So instead of pretending
 *     the advertised list is exact, the bundle refuses to *execute* anything
 *     outside the curated set and records every attempt. The advertised list is
 *     measured from the provider side in docs/VERIFICATION.md, gap included.
 *
 *  2. CONFINEMENT. Mutating file tools (write, edit, apply_patch) are pinned to
 *     the workspace and /tmp. This is defence in depth: the real boundary is
 *     the mount table, but this stops the agent from scribbling on its own
 *     rootfs (/usr, /etc), which would silently poison the persistent snapshot.
 *     Reads are deliberately not confined.
 *
 *  3. AUDIT. Every tool call is appended to an append-only JSONL log inside the
 *     sandbox, with the injected credential redacted. That log is the evidence
 *     used by docs/VERIFICATION.md.
 *
 * Hook names below were verified against the reference clone
 * (packages/plugin/src/index.ts, `interface Hooks`), not from memory. Note that
 * the permission hook is `permission.ask`, NOT `permission.asked`.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

const TOOLS_FILE = "/usr/local/share/moat/tools.json"

/**
 * The curated set comes from moat's renderer, not from this file, so there is one
 * source of truth. The fallback exists only so the plugin still behaves sanely if
 * someone drops it into a config by hand.
 */
function loadToolPolicy() {
  try {
    const parsed = JSON.parse(readFileSync(TOOLS_FILE, "utf8"))
    if (Array.isArray(parsed.curated) && parsed.curated.length > 0) {
      return { curated: parsed.curated, excluded: parsed.excluded ?? [], preset: parsed.preset ?? "custom" }
    }
  } catch {
    /* fall through to the default below */
  }
  return {
    curated: ["read", "write", "edit", "apply_patch", "glob", "grep", "bash", "todowrite", "question"],
    excluded: ["webfetch", "websearch", "skill", "task"],
    preset: "core (default)",
  }
}

const POLICY = loadToolPolicy()
const CURATED = POLICY.curated
const EXCLUDED = POLICY.excluded

// The entry script already exports MOAT_AUDIT_LOG; honouring it keeps the
// plugin and the boot script pointing at the same directory (and lets the unit
// tests write into a temp dir instead of /var/log). The default is the path the
// sandbox uses in production.
const DEFAULT_AUDIT = "/var/log/moat/tools.jsonl"
const auditFile = () => process.env.MOAT_AUDIT_LOG || DEFAULT_AUDIT
const auditDir = () => dirname(auditFile())

/**
 * Names that look like secrets. moat's threat model is explicit: the agent runs
 * with no permission prompts and (in v0/v1) an open network, so the ONE thing
 * standing between a prompt-injected tool call and your provider key is that the
 * key should be worthless to steal. See docs/SPEC.md §1 and §7.5.
 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i

const credential = process.env.MOAT_INJECTED_CREDENTIAL ?? ""

let seq = 0
let permissionAsks = 0

function redact(value) {
  let text = typeof value === "string" ? value : JSON.stringify(value)
  if (text === undefined) text = String(value)
  if (credential && credential.length > 0) text = text.split(credential).join("<redacted:MOAT_INJECTED_CREDENTIAL>")
  return text.length > 600 ? `${text.slice(0, 600)}…<truncated>` : text
}

function append(file, record) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(record)}\n`)
  } catch {
    // Auditing must never break the agent loop.
  }
}

function allowedRoots(worktree) {
  return [resolve(worktree), "/tmp", "/var/tmp", "/dev/null"]
}

function assertConfined(label, rawPath, worktree) {
  if (typeof rawPath !== "string" || rawPath.length === 0) return
  const roots = allowedRoots(worktree)
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(worktree, rawPath)
  const ok = roots.some((root) => absolute === root || absolute.startsWith(`${root}/`))
  if (!ok) {
    throw new Error(
      `moat: refusing ${label} outside the workspace: ${rawPath}. ` +
        `The workspace is ${worktree}; /tmp is also writable.`,
    )
  }
}

/**
 * Which argument names a path, per tool, for the *mutation* guard.
 *
 * VERIFIED, not assumed: these are the model-facing parameter names, read back
 * from the running server with `GET /experimental/tool` and recorded in
 * docs/VERIFICATION.md. opencode's internal schemas declare `path`
 * (packages/core/src/tool/{read,write,edit}.ts) but the provider-facing schema
 * renames it to `filePath` for read/write/edit. Checking the wrong spelling here
 * fails silently and confines nothing at all, so both are accepted.
 *
 * Only *mutating* tools are confined. Reads are not: the box is disposable and
 * contains nothing sensitive, and an agent legitimately wants /etc/os-release,
 * /proc/cpuinfo and friends. Confinement exists to protect the persistent
 * snapshot from being scribbled on, which only writes can do.
 */
const MUTATING_PATH_ARGS = {
  write: ["filePath", "path"],
  edit: ["filePath", "path"],
}

const ABSOLUTE_PATH_IN_PATCH = /^\*\*\* (?:Update|Add|Delete) File: (\S+)$/gm
// apply_patch can move a file as well as update it. The destination was not
// checked, so a move out of the workspace slipped past the guard.
const PATCH_MOVE_TARGET = /^\*\*\* Move to: (\S+)$/gm

export const MoatBundle = async ({ worktree, directory, serverUrl }) => {
  const root = worktree || directory
  try {
    mkdirSync(auditDir(), { recursive: true })
    const serveEnvNames = Object.keys(process.env).sort()
    writeFileSync(
      join(auditDir(), "exposure.json"),
      `${JSON.stringify(
        {
          plugin: "moat-bundle",
          workspace: root,
          serveEnvNames,
          secretNamesInServeEnv: serveEnvNames.filter((name) => SECRET_NAME.test(name)),
          // What the shell.env hook overrides to "" for commands the agent writes.
          redactedInShellEnv: serveEnvNames.filter((name) => SECRET_NAME.test(name)),
          opencodeServer: String(serverUrl ?? ""),
          caveat:
            "The bundle blanks secret-looking variables in the shell environment the agent's commands " +
            "inherit, but the values remain in the opencode process environment and are readable from " +
            "inside the sandbox via /proc/<pid>/environ by any process running as the same uid. " +
            "The control that matters is at the provider: a short-lived, spend-capped, narrowly scoped token.",
          writtenAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    )
  } catch {
    /* best effort */
  }

  try {
    writeFileSync(
      join(auditDir(), "bundle.json"),
      `${JSON.stringify(
        {
          plugin: "moat-bundle",
          workspace: root,
          toolPreset: POLICY.preset,
          curated: CURATED,
          excludedFromBuiltins: EXCLUDED,
          opencodeServer: String(serverUrl ?? ""),
          startedAt: new Date().toISOString(),
          // This file, like everything under /var/log/moat, lives inside the
          // agent-writable rootfs. It is a record of what the plugin did, not
          // tamper-proof evidence: a root process in the box can rewrite it.
          caveat: "written inside the sandbox rootfs; a root process in the box can modify or delete it",
        },
        null,
        2,
      )}\n`,
    )
  } catch {
    /* best effort */
  }

  return {
    config: async (config) => {
      // Invariant 3, re-checked inside the box. This runs in the agent's own
      // process, so a config that somehow reached the box without passing
      // render.ts's assertion still cannot start the session with an approval
      // rule in it.
      //
      // The check has to account for what opencode does to the config before this
      // hook sees it: `tools: {name: false}` is compiled into
      // `permission: {name: "deny"}` (packages/opencode/src/config/config.ts,
      // "if (result.tools)"). Requiring exactly `{"*":"allow"}` therefore rejected
      // every real boot — the ERROR was logged and ignored by opencode, so the
      // in-box check and the config audit record silently never happened. What
      // matters is that nothing can raise an approval prompt and no tool is denied
      // that moat did not curate out.
      const permission = config.permission ?? {}
      const disabled = new Set()
      for (const [tool, enabled] of Object.entries(config.tools ?? {})) {
        if (enabled !== false) continue
        disabled.add(tool)
        // Upstream collapses these three names into one `edit` rule.
        if (tool === "write" || tool === "edit" || tool === "patch") disabled.add("edit")
      }
      const illegal = Object.entries(permission).filter(([tool, action]) =>
        tool === "*" ? action !== "allow" : !(action === "deny" && disabled.has(tool)),
      )
      if (permission["*"] !== "allow" || illegal.length > 0) {
        throw new Error(
          `moat: refusing to run with permission ${JSON.stringify(permission)}; ` +
            'the bundle requires {"*":"allow"} and denies only for the tools it curates out ' +
            `(disabled: ${[...disabled].sort().join(", ") || "none"})`,
        )
      }

      // Curation assertion. If a future opencode changes the filter semantics,
      // this is where moat finds out instead of silently shipping more tools.
      const declared = Object.entries(config.tools ?? {})
        .filter(([, enabled]) => enabled === false)
        .map(([name]) => name)
      const missing = EXCLUDED.filter((name) => !declared.includes(name))
      try {
        mkdirSync(auditDir(), { recursive: true })
        appendFileSync(
          auditFile(),
          `${JSON.stringify({
            seq: seq++,
            ts: new Date().toISOString(),
            phase: "config",
            permission: config.permission ?? null,
            toolOmissions: declared,
            curationGaps: missing,
          })}\n`,
        )
      } catch {
        /* best effort */
      }
      if (missing.length > 0) {
        throw new Error(`moat: bundle is not curating the expected tools; missing omissions: ${missing.join(", ")}`)
      }
    },

    "permission.ask": async (input, output) => {
      permissionAsks += 1
      append(join(auditDir(), "permissions.jsonl"), { ts: new Date().toISOString(), seq: permissionAsks, input: redact(input), granted: "allow" })
      // Local sessions only, single user, disposable box: allow unconditionally.
      // With `"permission": {"*": "allow"}` this hook should never fire at all;
      // the verification suite asserts the count stays at zero.
      output.status = "allow"
    },

    "tool.execute.before": async (input, output) => {
      const args = output.args ?? {}
      // Hard curation boundary. This is the mechanism that makes "the user gets
      // exactly the tools the bundle declares" true in behaviour, even though
      // opencode still advertises a superset.
      if (!CURATED.includes(input.tool)) {
        append(auditFile(), {
          seq: seq++,
          ts: new Date().toISOString(),
          phase: "curation-refusal",
          tool: input.tool,
          sessionID: input.sessionID,
          callID: input.callID,
          reason: "tool is not in the moat bundle",
        })
        throw new Error(
          `moat: tool "${input.tool}" is not part of this sandbox's bundle. ` +
            `Available tools: ${CURATED.join(", ")}.`,
        )
      }
      for (const key of MUTATING_PATH_ARGS[input.tool] ?? []) {
        assertConfined(`${input.tool}.${key}`, args[key], root)
      }
      if (input.tool === "apply_patch" && typeof args.patchText === "string") {
        for (const pattern of [ABSOLUTE_PATH_IN_PATCH, PATCH_MOVE_TARGET]) {
          for (const match of args.patchText.matchAll(pattern)) {
            assertConfined("apply_patch.patchText", match[1], root)
          }
        }
      }
      append(auditFile(), {
        seq: seq++,
        ts: new Date().toISOString(),
        phase: "before",
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        args: redact(args),
      })
    },

    "tool.execute.after": async (input, output) => {
      // This hook runs when a tool call completes; opencode does not pass a
      // failure flag here, and a thrown tool surfaces as an error event rather
      // than as this hook with ok:false. The record used to say "ok": true,
      // which was always true and told a reader nothing. It now says only what
      // this hook can attest: the call completed. A failed call is a missing
      // after-record, and the audit log as a whole is best-effort: it lives in
      // the agent-writable rootfs, so it is a record, not tamper-proof evidence.
      append(auditFile(), {
        seq: seq++,
        ts: new Date().toISOString(),
        phase: "after",
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        title: output.title,
        completed: true,
        output: redact(output.output ?? ""),
      })
    },

    "shell.env": async (_input, output) => {
      // CRITICAL, and verified against the source rather than assumed:
      // opencode merges this overlay onto its own process environment, 
      //   return { ...process.env, ...extra.env }   (tool/shell.ts:422)
      // so `delete output.env.X` removes nothing, and the only way to take a
      // variable away from a shell command is to OVERRIDE it. An earlier
      // revision of this plugin did `delete`, which was a silent no-op.
      //
      // This blanks every secret-looking variable for commands the *agent*
      // writes. It is a speed bump, not a boundary: the real values still live
      // in the opencode process environment and any process running as the same
      // uid can read them from /proc/<pid>/environ. `moat doctor` says so, and
      // the fix that actually matters is a provider-scoped, spend-capped token.
      for (const name of Object.keys(process.env)) {
        if (SECRET_NAME.test(name)) output.env[name] = ""
      }
    },

    dispose: async () => {
      append(join(auditDir(), "permissions.jsonl"), { ts: new Date().toISOString(), summary: true, permissionAsks })
    },
  }
}

export default MoatBundle
