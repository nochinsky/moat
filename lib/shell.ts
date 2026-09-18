import { spawn } from "node:child_process"

export type RunResult = {
  code: number
  stdout: string
  stderr: string
  cmd: string
}

export class CommandError extends Error {
  result: RunResult
  constructor(result: RunResult) {
    super(`command failed (exit ${result.code}): ${result.cmd}\n${result.stderr.trim()}`)
    this.name = "CommandError"
    this.result = result
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Run a command to completion, capturing output. Never uses a shell: every
 * argument is passed through verbatim, which is what makes it safe to hand it
 * project paths and credentials.
 */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; allowFailure?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d: string) => (stdout += d))
    child.stderr.on("data", (d: string) => (stderr += d))
    child.on("error", reject)
    child.on("close", (code) => {
      const result: RunResult = {
        code: code ?? -1,
        stdout,
        stderr,
        cmd: [cmd, ...args].map(shellQuote).join(" "),
      }
      if (result.code !== 0 && !opts.allowFailure) reject(new CommandError(result))
      else resolve(result)
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

/** Run a command and return trimmed stdout, throwing on failure. */
export async function out(cmd: string, args: string[], opts?: Parameters<typeof run>[2]): Promise<string> {
  const result = await run(cmd, args, opts)
  return result.stdout.trim()
}

export async function ok(cmd: string, args: string[], opts?: Parameters<typeof run>[2]): Promise<boolean> {
  try {
    await run(cmd, args, opts)
    return true
  } catch {
    return false
  }
}

export async function which(bin: string): Promise<string | null> {
  const result = await run("sh", ["-c", `command -v ${shellQuote(bin)}`], { allowFailure: true })
  return result.code === 0 ? result.stdout.trim() || null : null
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
