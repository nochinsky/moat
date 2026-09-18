import type { EnvState } from "../sandbox/state.ts"
import * as log from "../lib/log.ts"
import { sleep } from "../lib/shell.ts"

/**
 * Host-side attachment to the opencode server running *inside* the sandbox.
 *
 * There is deliberately no tool proxying here. The sandbox runs
 * `opencode serve` and the host speaks its HTTP API directly. That is why moat
 * never has to forward a filesystem, a socket or a subprocess: the agent loop
 * lives entirely inside the box, and the host is only a client.
 *
 * The client is the official `@opencode-ai/sdk`, the same generated client
 * opencode itself ships.
 */

export type Client = Awaited<ReturnType<typeof connect>>

export function baseUrl(state: EnvState): string {
  if (!state.port) throw new Error("sandbox has no recorded port")
  return `http://127.0.0.1:${state.port}`
}

export function authHeaders(password: string, username = "opencode"): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
}

export async function loadSdk() {
  try {
    return await import("@opencode-ai/sdk")
  } catch (error) {
    throw new Error(
      "the opencode client is not installed. Run `npm install` in the moat checkout. " +
        `(underlying error: ${(error as Error).message})`,
    )
  }
}

export async function connect(state: EnvState, password: string, directory?: string) {
  const sdk = await loadSdk()
  return sdk.createOpencodeClient({
    baseUrl: baseUrl(state),
    headers: authHeaders(password),
    directory,
  })
}

export async function waitForServer(
  state: EnvState,
  password: string,
  opts: { timeoutMs?: number; logFile?: string } = {},
): Promise<{ ok: boolean; ms: number; detail: string }> {
  const timeoutMs = opts.timeoutMs ?? 60000
  const started = Date.now()
  const url = `${baseUrl(state)}/config`
  let lastDetail = "no attempt made"
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { headers: authHeaders(password), signal: AbortSignal.timeout(2500) })
      if (response.ok) {
        return { ok: true, ms: Date.now() - started, detail: `GET /config -> ${response.status}` }
      }
      if (response.status === 401) {
        return { ok: false, ms: Date.now() - started, detail: "GET /config -> 401 (password mismatch)" }
      }
      lastDetail = `GET /config -> ${response.status}`
    } catch (error) {
      lastDetail = `GET /config -> ${(error as Error).name}`
    }
    await sleep(250)
  }
  return { ok: false, ms: Date.now() - started, detail: `${lastDetail} after ${timeoutMs}ms` }
}

export type SessionResult = {
  sessionID: string
  text: string
  toolCalls: { tool: string; status: string; title?: string }[]
  errors: string[]
}

type Part = {
  type?: string
  text?: string
  tool?: string
  state?: { status?: string; title?: string; input?: unknown; output?: string; error?: string }
}

/**
 * Drive one prompt to completion and return everything the agent did.
 *
 * `session.prompt` is the SDK's blocking call: it resolves with the finished
 * assistant message, so the parts array is a complete transcript of the turn.
 */
export async function driveSession(
  client: Client,
  input: {
    sessionID?: string
    prompt: string
    providerID: string
    modelID: string
    agent?: string
    onEvent?: (line: string) => void
    /** Also emit each tool's output (truncated). */
    showOutput?: boolean
  },
): Promise<SessionResult> {
  let sessionID = input.sessionID
  if (!sessionID) {
    const created = await client.session.create({ body: { title: "moat session" } })
    const data = created.data as { id?: string } | undefined
    if (!data?.id) throw new Error(`failed to create session: ${JSON.stringify(created.error ?? created)}`)
    sessionID = data.id
  }

  const response = await client.session.prompt({
    path: { id: sessionID },
    body: {
      model: { providerID: input.providerID, modelID: input.modelID },
      agent: input.agent,
      parts: [{ type: "text", text: input.prompt }],
    },
  })

  if (response.error) {
    throw new Error(`prompt failed: ${JSON.stringify(response.error)}`)
  }

  // `session.prompt` resolves with the *final* assistant message. Tool calls live
  // in earlier assistant messages, so the whole session is read back and folded
  // into one transcript. Without this, a successful agent run reports "no tools",
  // which is exactly the kind of claim this project is not allowed to make.
  const transcript = await client.session.messages({ path: { id: sessionID } })
  const messages = (transcript.data ?? []) as { info?: { role?: string }; parts?: Part[] }[]

  const toolCalls: SessionResult["toolCalls"] = []
  const errors: string[] = []
  let lastAssistantText = ""

  if (messages.length === 0) {
    const message = response.data as { parts?: Part[] } | undefined
    messages.push({ info: { role: "assistant" }, parts: message?.parts ?? [] })
  }

  for (const message of messages) {
    const role = message.info?.role ?? "assistant"
    let messageText = ""
    for (const part of message.parts ?? []) {
      if (part.type === "text" && part.text) messageText += part.text
      if (part.type === "tool" && part.tool) {
        const status = part.state?.status ?? "unknown"
        toolCalls.push({ tool: part.tool, status, title: part.state?.title })
        input.onEvent?.(`[tool] ${part.tool} (${status}) ${part.state?.title ?? ""}`)
        const detail = part.state?.error ?? part.state?.output
        if (status === "error") {
          errors.push(`${part.tool}: ${detail ?? "failed"}`)
          input.onEvent?.(`[tool-error] ${part.tool}: ${truncate(detail ?? "failed")}`)
        } else if (input.showOutput) {
          input.onEvent?.(`[tool-output]\n${truncate(detail ?? "")}`)
        }
      }
    }
    if (role === "assistant" && messageText.trim().length > 0) {
      lastAssistantText = messageText
      input.onEvent?.(messageText)
    }
  }

  return { sessionID, text: lastAssistantText, toolCalls, errors }
}

function truncate(text: string, limit = 2000): string {
  const trimmed = text.trimEnd()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n…<truncated>` : trimmed
}

export async function toolIds(client: Client): Promise<string[]> {
  const response = await client.tool.ids()
  return (response.data as string[] | undefined) ?? []
}

export async function listSessions(client: Client): Promise<{ id: string; title: string }[]> {
  const response = await client.session.list()
  const data = response.data as { id: string; title?: string }[] | undefined
  return (data ?? []).map((s) => ({ id: s.id, title: s.title ?? "" }))
}

export async function messages(client: Client, sessionID: string): Promise<number> {
  const response = await client.session.messages({ path: { id: sessionID } })
  const data = response.data as unknown[] | undefined
  return data?.length ?? 0
}

export function describeConnection(state: EnvState, password: string): string {
  return [
    `url      ${baseUrl(state)}`,
    `user     opencode`,
    `password ${password}`,
    `dir      /work`,
  ].join("\n")
}

export { log }
