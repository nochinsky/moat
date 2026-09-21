/**
 * moat's flags: the ones that exist, and which command reads which.
 *
 * Two tables, because one was not enough. `SPEC` is every flag moat knows, so a
 * typo is refused as an unknown flag. `COMMAND_FLAGS` is what each command
 * actually reads, and it exists because `SPEC` is shared by every command: a flag
 * a command did not read used to be accepted and then dropped on the floor. That
 * was not theoretical — `moat verify --timeout 1` was ignored (the checks runner
 * has taken a timeout from the beginning; no caller passed one), and `--quiet`,
 * which every test harness passes, was read by nothing at all.
 *
 * A provided flag the command does not read is now refused before the command
 * starts, naming the flag and the command. A silent drop is the worst of the three
 * possible answers; refusing is the other extreme and the honest one.
 */

export type FlagType = "boolean" | "string" | "number"
export type Spec = Record<string, FlagType>
export type Parsed = { _: string[]; flags: Record<string, string | boolean | number> }

/** Every flag moat knows. A token outside this table is an unknown flag. */
export const SPEC: Spec = {
  help: "boolean",
  json: "boolean",
  verbose: "boolean",
  model: "string",
  provider: "string",
  effort: "string",
  profile: "string",
  profiles: "boolean",
  refresh: "boolean",
  "list-models": "boolean",
  "base-url": "string",
  upstream: "string",
  credential: "string",
  "credential-env": "string",
  "credential-ttl": "string",
  "no-credential": "boolean",
  egress: "string",
  "egress-allow": "string",
  fresh: "boolean",
  sync: "boolean",
  all: "boolean",
  checkout: "boolean",
  name: "string",
  dir: "string",
  keep: "boolean",
  "env-var": "string",
  "wire-api": "string",
  remove: "boolean",
  yes: "boolean",
  tail: "number",
  timeout: "number",
  "show-output": "boolean",
  "commit-worktree": "boolean",
  "no-detect": "boolean",
  "no-follow": "boolean",
  "no-verify": "boolean",
  "skip-conflicts": "boolean",
  "dry-run": "boolean",
  force: "boolean",
  quiet: "boolean",
}

/**
 * Flags every command understands.
 *
 * `--help` is handled before dispatch, and `--verbose`/`--quiet` are handled by the
 * logger, so every command can take them without reading them itself.
 */
export const GLOBAL_FLAGS: readonly string[] = ["help", "quiet", "verbose"]

/** `moat run "task"` is `moat up "task"`: same command, same flags. */
const UP_FLAGS: readonly string[] = [
  "base-url",
  "provider",
  "credential",
  "credential-env",
  "credential-ttl",
  "egress",
  "effort",
  "egress-allow",
  "force",
  "fresh",
  "json",
  "model",
  "no-credential",
  "no-detect",
  "no-follow",
  "profile",
  "refresh",
  "show-output",
  "sync",
  "timeout",
  "upstream",
  "yes",
]

/**
 * What each command reads. Keep it in step with the code: a flag missing here is
 * refused with a message rather than ignored, which is loud enough to notice.
 */
export const COMMAND_FLAGS: Record<string, readonly string[]> = {
  up: UP_FLAGS,
  run: UP_FLAGS,
  fetch: ["all", "commit-worktree", "json"],
  apply: ["checkout", "dry-run", "json", "name", "skip-conflicts"],
  take: ["no-verify", "timeout"],
  verify: ["json", "timeout"],
  down: [],
  destroy: ["all", "yes"],
  status: ["all", "json"],
  snapshot: ["yes"],
  restore: ["yes"],
  logs: ["tail"],
  doctor: ["json"],
  shell: [],
  exec: [],
  models: ["json", "refresh"],
  provider: ["remove", "base-url", "env-var", "wire-api", "model", "json"],
  profiles: ["json"],
  demo: ["dir", "keep", "timeout"],
}

/** A flag that does not exist, or one this command does not read. */
export class FlagError extends Error {}

export function parse(argv: string[], spec: Spec, command?: string): Parsed {
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
    if (!type) throw new FlagError("unknown flag: " + token)
    if (type === "boolean") {
      flags[key] = inline === undefined ? true : inline !== "false"
      continue
    }
    const value = inline ?? argv[++i]
    if (value === undefined) throw new FlagError("flag --" + key + " needs a value")
    flags[key] = type === "number" ? Number(value) : value
  }

  if (command && Object.prototype.hasOwnProperty.call(COMMAND_FLAGS, command)) {
    const allowed = new Set<string>([...GLOBAL_FLAGS, ...COMMAND_FLAGS[command]!])
    const ignored = Object.keys(flags).filter((key) => !allowed.has(key))
    if (ignored.length > 0) {
      const list = ignored.map((key) => "--" + key).join(", ")
      throw new FlagError(
        list +
          (ignored.length === 1 ? " has" : " have") +
          " no effect on `moat " +
          command +
          "`, so " +
          (ignored.length === 1 ? "it is" : "they are") +
          " refused rather than ignored.\n" +
          "  moat's flag table is shared by every command; `moat help` lists the commands.",
      )
    }
  }

  return { _: rest, flags }
}

export function flag<T>(p: Parsed, key: string): T | undefined {
  const value = p.flags[key]
  return value === undefined ? undefined : (value as T)
}
