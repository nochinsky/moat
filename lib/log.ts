/**
 * Tiny stderr logger. Everything moat says about its own operation goes to
 * stderr so that command results on stdout stay pipeable.
 */

const useColor = process.stderr.isTTY && !process.env.NO_COLOR
const paint = (code: string, text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text)

export const dim = (text: string) => paint("2", text)
export const bold = (text: string) => paint("1", text)
export const red = (text: string) => paint("31", text)
export const green = (text: string) => paint("32", text)
export const yellow = (text: string) => paint("33", text)
export const cyan = (text: string) => paint("36", text)

export const verbose = process.env.MOAT_VERBOSE === "1"

let quiet = false

/**
 * Hide the progress lines (`step`).
 *
 * `--quiet` is about the progress chatter, not about hiding what happened:
 * warnings, errors and results still print. Set from `--quiet` in main().
 */
export function setQuiet(value: boolean): void {
  quiet = value
}

export function step(message: string): void {
  if (quiet) return
  process.stderr.write(`${cyan("→")} ${message}\n`)
}

export function info(message: string): void {
  process.stderr.write(`${message}\n`)
}

export function debug(message: string): void {
  if (verbose) process.stderr.write(`${dim(message)}\n`)
}

export function warn(message: string): void {
  process.stderr.write(`${yellow("!")} ${message}\n`)
}

export function fail(message: string): never {
  process.stderr.write(`${red("✗")} ${message}\n`)
  process.exit(1)
}

export function success(message: string): void {
  process.stderr.write(`${green("✓")} ${message}\n`)
}

/** Print a machine-readable payload on stdout. `--json` turns the CLI into an API. */
export function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}
