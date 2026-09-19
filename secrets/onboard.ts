import fs from "node:fs"
import path from "node:path"

import { credentialsFile, ensureMoatHome } from "../lib/paths.ts"
import { DEEPSEEK, CREDENTIAL_ENV_VARS } from "../lib/provider.ts"
import * as log from "./../lib/log.ts"

/**
 * First-run setup: ask for the key, check it, save it.
 *
 * The alternative is what moat did before, which was to explain in a warning that
 * a key was missing and leave the user to work out the rest. That is a fine
 * message for a scripted run and a poor one for the first thing a person sees.
 *
 * Two details matter more than they look:
 *  - the key is never echoed, because terminals keep scrollback and people paste
 *    keys into shared screens;
 *  - it is checked against the provider *before* being saved, because a typo
 *    saved silently turns into a confusing failure several steps later.
 */

const VERIFY_URL = `${DEEPSEEK.baseUrl}/models`
const VERIFY_TIMEOUT_MS = 15000

/** Read a line with the input hidden. Ctrl-C cancels. */
export function askHidden(question: string): Promise<string> {
  process.stdout.write(question)
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    const wasRaw = stdin.isRaw === true
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()

    let value = ""
    const cleanup = () => {
      stdin.removeListener("data", onData)
      if (stdin.isTTY) stdin.setRawMode(wasRaw)
      stdin.pause()
    }
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          cleanup()
          process.stdout.write("\n")
          resolve(value.trim())
          return
        }
        if (char === "\u0003") {
          cleanup()
          process.stdout.write("\n")
          reject(new Error("cancelled"))
          return
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write("\b \b")
          }
          continue
        }
        value += char
        process.stdout.write("*")
      }
    }
    stdin.on("data", onData)
  })
}

export type VerifyResult = { ok: boolean; detail: string; models?: string[] }

/** Ask the provider whether the key works, before trusting it. */
export async function verifyKey(key: string): Promise<VerifyResult> {
  try {
    const response = await fetch(VERIFY_URL, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, detail: "the provider rejected it" }
    }
    if (!response.ok) return { ok: false, detail: `the provider answered ${response.status}` }
    const body = (await response.json()) as { data?: { id?: string }[] }
    const models = (body.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id))
    return { ok: true, detail: "accepted", models }
  } catch (error) {
    // No network is not the same as a bad key, and refusing to save a working key
    // because the wifi is down would be worse than not checking at all.
    return { ok: false, detail: `could not reach the provider (${(error as Error).name})` }
  }
}

/** Save the key where the broker looks, mode 0600, without disturbing anything else. */
export function saveCredential(key: string, provider = DEEPSEEK.opencodeID): string {
  const file = credentialsFile()
  ensureMoatHome()
  let store: Record<string, { value: string; baseUrl?: string; model?: string }> = {}
  if (fs.existsSync(file)) {
    try {
      store = JSON.parse(fs.readFileSync(file, "utf8")) as typeof store
    } catch {
      log.warn(`${file} is not valid JSON; it will be replaced`)
    }
  }
  store[provider] = { ...(store[provider] ?? {}), value: key }
  // Write beside the target and rename: a reader never sees a half-written
  // store, and the mode is set before the file has its final name.
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
  return file
}

export function hasCredential(): boolean {
  return CREDENTIAL_ENV_VARS.some((name) => Boolean(process.env[name])) || fs.existsSync(credentialsFile())
}

/**
 * Ask, check, save. Returns the key, or null if the user gave up.
 *
 * `attempts` is finite on purpose: a loop that keeps asking is a loop that keeps
 * someone stuck at a prompt they cannot satisfy.
 */
export async function onboard(opts: { attempts?: number } = {}): Promise<string | null> {
  const attempts = opts.attempts ?? 3

  log.info("")
  log.info(`${log.bold("moat needs a DeepSeek API key.")}`)
  log.info(`  ${log.dim("Get one at https://platform.deepseek.com/api_keys")}`)
  log.info(`  ${log.dim(`It will be saved to ${credentialsFile()} (mode 600) and sent only to ${DEEPSEEK.baseUrl}.`)}`)
  log.info("")

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let key: string
    try {
      key = await askHidden(`  ${DEEPSEEK.envVar}: `)
    } catch {
      log.info("  cancelled")
      return null
    }
    if (key.length === 0) {
      log.info("  nothing entered")
      continue
    }

    process.stdout.write(`  ${log.dim("checking...")}\r`)
    const result = await verifyKey(key)
    process.stdout.write("                    \r")

    if (result.ok) {
      const file = saveCredential(key)
      const models = result.models && result.models.length > 0 ? ` (${result.models.join(", ")})` : ""
      log.success(`key accepted${models}, saved to ${file}`)
      return key
    }

    if (result.detail.startsWith("could not reach")) {
      // The key might be fine. Say so, and let the user decide.
      log.warn(`${result.detail}. Saving it without checking.`)
      saveCredential(key)
      return key
    }

    log.warn(`${result.detail}. ${attempt < attempts ? "Try again." : "Giving up."}`)
  }
  return null
}
