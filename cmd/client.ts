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
    /** Reasoning effort. Must be one this model actually offers; see modelVariants(). */
    variant?: string
    onEvent?: (line: string) => void
    /** Raw text fragments, written without a trailing newline. */
    onDelta?: (text: string) => void
    /** Also emit each tool's output (truncated). */
    showOutput?: boolean
    /** Give up on a turn after this long and return what we have. */
    timeoutMs?: number
    /**
     * Called when the agent asks the user something.
     *
     * Required in practice: this path is never attended, and a question nobody
     * can answer would hang the turn. The handler rejects it so the agent is
     * told to decide for itself.
     */
    onQuestion: (requestID: string) => Promise<void>
  },
): Promise<SessionResult> {
  const sessionID = input.sessionID ?? (await createSession(client))
  try {
    return await driveStreaming(client, sessionID, input)
  } catch (error) {
    // Streaming is the pleasant path, not the only path. If the event stream is
    // unavailable for any reason, fall back to the blocking call and say so.
    input.onEvent?.(`[stream] unavailable (${(error as Error).message}); falling back to waiting for the whole turn`)
    return await driveBlocking(client, sessionID, input)
  }
}

async function createSession(client: Client): Promise<string> {
  const created = await client.session.create({ body: { title: "moat session" } })
  const data = created.data as { id?: string } | undefined
  if (!data?.id) throw new Error(`failed to create session: ${JSON.stringify(created.error ?? created)}`)
  return data.id
}

type Part = {
  id?: string
  sessionID?: string
  messageID?: string
  type?: string
  text?: string
  tool?: string
  callID?: string
  state?: { status?: string; title?: string; input?: unknown; output?: string; error?: string }
}

/**
 * Build a prompt body.
 *
 * Exported so the interactive session builds its prompts the same way the
 * one-shot paths do, rather than each call site re-deriving the shape and
 * reaching for its own cast to get past the SDK's older generated types.
 */
export function promptBody(input: {
  prompt: string
  providerID: string
  modelID: string
  agent?: string
  /**
   * opencode's "variant": a provider-specific reasoning effort. The server
   * accepts this (`session/prompt.ts` declares `variant` optional on the prompt
   * input) but the published SDK's generated types lag behind. Returning this
   * object from a function is what keeps that from being a type error —
   * TypeScript rejects unknown properties only on fresh literals.
   *
   * For DeepSeek it reaches the provider as `reasoning_effort`. Which levels
   * exist is a property of the model, not of moat: the server publishes the
   * exact map at `GET /config/providers`, and that is what `modelVariants()`
   * reads. An unknown variant is ignored rather than rejected, so offering a
   * level the model does not have would fail silently — hence discovery, never
   * a hardcoded list.
   */
  variant?: string
}) {
  return {
    model: { providerID: input.providerID, modelID: input.modelID },
    agent: input.agent,
    variant: input.variant,
    parts: [{ type: "text" as const, text: input.prompt }],
  }
}

/**
 * Drive a turn and report it as it happens.
 *
 * The blocking `session.prompt` call shows nothing until the whole turn is over,
 * which on a real task means minutes of a blank terminal. That reads as "hung",
 * and the natural reaction is Ctrl-C, which loses the turn. So the event stream
 * is subscribed to first, the prompt is started asynchronously, and parts are
 * reported as they arrive. `session.idle` ends the turn.
 */
async function driveStreaming(
  client: Client,
  sessionID: string,
  input: {
    prompt: string
    providerID: string
    modelID: string
    agent?: string
    variant?: string
    onEvent?: (line: string) => void
    onDelta?: (text: string) => void
    showOutput?: boolean
    timeoutMs?: number
    onQuestion?: (requestID: string) => Promise<void>
  },
): Promise<SessionResult> {
  const deadline = Date.now() + (input.timeoutMs ?? 45 * 60 * 1000)
  const controller = new AbortController()
  const subscription = await client.event.subscribe({ signal: controller.signal })

  let text = ""
  let midText = false
  const toolStatus = new Map<string, string>()
  const errors: string[] = []
  // The event stream carries the user's own prompt as a text part too. Only
  // assistant message ids are streamed, or the prompt echoes back at you.
  const assistantMessages = new Set<string>()
  // Deltas identify their part only by id, so the kind of each part is recorded
  // as the `message.part.updated` events go by.
  const partKind = new Map<string, string>()

  const endText = () => {
    if (midText) {
      input.onDelta?.("\n")
      midText = false
    }
  }

  await client.session.promptAsync({
    path: { id: sessionID },
    body: promptBody(input),
  })

  const iterator = subscription.stream[Symbol.asyncIterator]()
  let pending = iterator.next()
  let idle = false
  let abortRequested = false
  let lastEvent = Date.now()

  try {
    while (!idle) {
      const outcome = await Promise.race([
        pending.then((value) => ({ kind: "event" as const, value })),
        new Promise<{ kind: "tick" }>((resolve) => setTimeout(() => resolve({ kind: "tick" }), 15000)),
      ])

      if (outcome.kind === "tick") {
        if (Date.now() > deadline) {
          input.onEvent?.("[timeout] turn exceeded its budget; aborting")
          await client.session.abort({ path: { id: sessionID } }).catch(() => undefined)
          break
        }
        // Silence means the model is thinking. Say so rather than looking dead.
        if (Date.now() - lastEvent > 30000) {
          endText()
          input.onEvent?.(`[waiting] no output for ${Math.round((Date.now() - lastEvent) / 1000)}s`)
          lastEvent = Date.now()
        }
        continue
      }

      const { value, done } = outcome.value
      if (done) break
      pending = iterator.next()
      lastEvent = Date.now()

      const event = value as { type?: string; properties?: Record<string, unknown> }
      const properties = event.properties ?? {}

      if (event.type === "message.updated") {
        const info = properties.info as { id?: string; role?: string; sessionID?: string } | undefined
        if (info?.role === "assistant" && info.id && (!info.sessionID || info.sessionID === sessionID)) {
          assistantMessages.add(info.id)
        }
        continue
      }

      if (event.type === "message.part.delta") {
        // This is where streamed text actually arrives. `message.part.updated`
        // does not carry `delta`, so anyone waiting for it there prints nothing
        // until the turn is over.
        const partID = properties.partID as string | undefined
        const messageID = properties.messageID as string | undefined
        const delta = properties.delta
        if (typeof delta !== "string" || delta.length === 0) continue
        if (messageID && !assistantMessages.has(messageID)) continue
        if (partID && partKind.get(partID) !== "text") continue
        text += delta
        midText = true
        input.onDelta?.(delta)
        continue
      }

      if (event.type === "message.part.updated") {
        const part = properties.part as Part | undefined
        if (!part || (part.sessionID && part.sessionID !== sessionID)) continue
        if (part.id && part.type) partKind.set(part.id, part.type)

        if (part.type === "tool" && part.tool) {
          const status = part.state?.status ?? "unknown"
          // `pending` is the instant between the model emitting a call and the
          // tool starting; reporting it just doubles every line.
          if (status === "pending") continue
          const key = part.callID ?? part.tool
          if (toolStatus.get(key) !== status) {
            toolStatus.set(key, status)
            endText()
            input.onEvent?.(`[tool] ${part.tool} (${status}) ${part.state?.title ?? ""}`)
            const detail = part.state?.error ?? part.state?.output
            if (status === "error") errors.push(`${part.tool}: ${detail ?? "failed"}`)
            if (status === "error" || (status === "completed" && input.showOutput)) {
              input.onEvent?.(`[tool-${status === "error" ? "error" : "output"}] ${truncate(detail ?? "")}`)
            }
          }
          continue
        }
      }

      if (event.type === "question.asked") {
        const request = (properties as { request?: { id?: string } }).request ?? (properties as { id?: string })
        if (request?.id) {
          // Unattended by construction: the interactive path is the REPL, which
          // runs its own loop and answers questions properly. There is no way to
          // unblock the tool from here, so the turn is ended rather than stalled.
          await input.onQuestion?.(request.id)
          abortRequested = true
          await client.session.abort({ path: { id: sessionID } }).catch(() => undefined)
        }
        continue
      }

      if (event.type === "session.idle" && properties.sessionID === sessionID) idle = true
      if (event.type === "session.error" && abortRequested) idle = true
      if (event.type === "session.error" && (!properties.sessionID || properties.sessionID === sessionID)) {
        errors.push(`session error: ${truncate(JSON.stringify(properties.error ?? properties))}`)
        idle = true
      }
    }
  } finally {
    controller.abort()
    endText()
  }

  // The event stream is a live view; the transcript is the record. Re-read it so
  // the returned result is authoritative rather than reconstructed from deltas.
  return await collect(client, sessionID, errors)
}

/** The blocking path, kept as a fallback. */
async function driveBlocking(
  client: Client,
  sessionID: string,
  input: { prompt: string; providerID: string; modelID: string; agent?: string; variant?: string; onEvent?: (line: string) => void; onDelta?: (text: string) => void; showOutput?: boolean; timeoutMs?: number },
): Promise<SessionResult> {
  const errors: string[] = []
  const response = await client.session.prompt({ path: { id: sessionID }, body: promptBody(input) })
  if (response.error) throw new Error(`prompt failed: ${JSON.stringify(response.error)}`)
  const result = await collect(client, sessionID, errors)
  if (result.text) input.onDelta?.(result.text.endsWith("\n") ? result.text : `${result.text}\n`)
  return result
}

/** Fold the whole session into one transcript. */
async function collect(client: Client, sessionID: string, errors: string[]): Promise<SessionResult> {
  const transcript = await client.session.messages({ path: { id: sessionID } })
  const messages = (transcript.data ?? []) as { info?: { role?: string }; parts?: Part[] }[]

  const toolCalls: SessionResult["toolCalls"] = []
  let lastAssistantText = ""

  for (const message of messages) {
    const role = message.info?.role ?? "assistant"
    let messageText = ""
    for (const part of message.parts ?? []) {
      if (part.type === "text" && part.text) messageText += part.text
      if (part.type === "tool" && part.tool) {
        const status = part.state?.status ?? "unknown"
        toolCalls.push({ tool: part.tool, status, title: part.state?.title })
        if (status === "error") {
          const detail = `${part.tool}: ${part.state?.error ?? part.state?.output ?? "failed"}`
          if (!errors.includes(detail)) errors.push(detail)
        }
      }
    }
    if (role === "assistant" && messageText.trim().length > 0) lastAssistantText = messageText
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

// ---------------------------------------------------------------------------
// Models and agents
//
// Both come from the server rather than from a list moat keeps. The server is
// the thing that will actually run the request, so it is the only authority on
// which models exist, what they cost, and which reasoning levels each one
// accepts. Reading them means moat never offers a choice that silently does
// nothing.
//
// The published SDK's `Model` type has no `variants` field, though the server
// sends one — verified against a live server, which reported
// `deepseek-v4-pro -> {high, max}` and `deepseek-flash -> {low, high, max}`.
// Rather than hardcode that, moat reads it.
// ---------------------------------------------------------------------------

export type ModelChoice = {
  providerID: string
  id: string
  name: string
  /** Reasoning levels this exact model accepts, weakest first. May be empty. */
  variants: string[]
  context: number
  output: number
  reasoning: boolean
  toolCall: boolean
}

type RawModel = {
  id?: string
  name?: string
  variants?: Record<string, unknown>
  capabilities?: { reasoning?: boolean; toolcall?: boolean }
  limit?: { context?: number; output?: number }
}

type RawProvider = { id?: string; models?: Record<string, RawModel> }

export async function listModels(client: Client): Promise<ModelChoice[]> {
  const response = await client.config.providers()
  const body = response.data as unknown as { providers?: RawProvider[] } | undefined
  const choices: ModelChoice[] = []
  for (const provider of body?.providers ?? []) {
    for (const [key, model] of Object.entries(provider.models ?? {})) {
      const id = model.id ?? key
      choices.push({
        providerID: provider.id ?? "unknown",
        id,
        name: model.name ?? id,
        variants: orderVariants(Object.keys(model.variants ?? {})),
        context: model.limit?.context ?? 0,
        output: model.limit?.output ?? 0,
        reasoning: model.capabilities?.reasoning === true,
        toolCall: model.capabilities?.toolcall !== false,
      })
    }
  }
  return choices.sort((a, b) => a.providerID.localeCompare(b.providerID) || a.id.localeCompare(b.id))
}

/**
 * Effort levels, weakest first.
 *
 * The server hands them over in its own (alphabetical) order, which reads as
 * noise in a menu. This is the ranking the levels actually mean; anything
 * unrecognised keeps its place at the end.
 */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

function orderVariants(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const ai = EFFORT_ORDER.indexOf(a)
    const bi = EFFORT_ORDER.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

export async function modelVariants(client: Client, providerID: string, modelID: string): Promise<string[]> {
  const models = await listModels(client)
  return models.find((m) => m.providerID === providerID && m.id === modelID)?.variants ?? []
}

export type AgentChoice = { name: string; description?: string; mode?: string }

export async function listAgents(client: Client): Promise<AgentChoice[]> {
  const response = await client.app.agents()
  const data = response.data as unknown as AgentChoice[] | undefined
  return (data ?? []).map((a) => ({ name: a.name, description: a.description, mode: a.mode }))
}

// ---------------------------------------------------------------------------
// Session controls
//
// opencode's own operations, present in the SDK and simply never surfaced by
// moat until now: compaction, and undoing the last turn.
// ---------------------------------------------------------------------------

export async function compact(client: Client, sessionID: string, providerID: string, modelID: string): Promise<boolean> {
  const response = await client.session.summarize({ path: { id: sessionID }, body: { providerID, modelID } })
  return !response.error
}

/** `messageID` is required by the route; pass the user message to roll back to. */
export async function revert(client: Client, sessionID: string, messageID: string): Promise<boolean> {
  const response = await client.session.revert({ path: { id: sessionID }, body: { messageID } })
  return !response.error
}

export async function unrevert(client: Client, sessionID: string): Promise<boolean> {
  const response = await client.session.unrevert({ path: { id: sessionID } })
  return !response.error
}

/** The most recent user message id, which is what "undo the last turn" means. */
export async function lastUserMessageID(client: Client, sessionID: string): Promise<string | undefined> {
  const response = await client.session.messages({ path: { id: sessionID } })
  const messages = (response.data ?? []) as unknown as { info?: { id?: string; role?: string } }[]
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info
    if (info?.role === "user" && info.id) return info.id
  }
  return undefined
}

export { log }

// ---------------------------------------------------------------------------
// Questions
//
// The server exposes these at /question, but the published SDK omits the
// bindings, so they are called directly. Verified against the route group in
// packages/opencode/src/server/routes/instance/httpapi/groups/question.ts:
//   GET  /question                     list pending questions
//   POST /question/:requestID/reply    { answers: string[][] }
//   POST /question/:requestID/reject
// ---------------------------------------------------------------------------

export type QuestionOption = { label: string; description: string }
export type QuestionInfo = {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}
export type QuestionRequest = { id: string; sessionID: string; questions: QuestionInfo[] }

async function questionCall(
  state: EnvState,
  password: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const response = await fetch(`${baseUrl(state)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...authHeaders(password),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
  const text = await response.text()
  try {
    return { ok: true, data: text ? JSON.parse(text) : undefined }
  } catch {
    return { ok: true, data: text }
  }
}

export async function listQuestions(state: EnvState, password: string): Promise<QuestionRequest[]> {
  const result = await questionCall(state, password, "/question")
  return result.ok && Array.isArray(result.data) ? (result.data as QuestionRequest[]) : []
}

export async function replyToQuestion(
  state: EnvState,
  password: string,
  requestID: string,
  answers: string[][],
): Promise<boolean> {
  const result = await questionCall(state, password, `/question/${requestID}/reply`, { answers })
  return result.ok
}

export async function rejectQuestion(state: EnvState, password: string, requestID: string): Promise<boolean> {
  const result = await questionCall(state, password, `/question/${requestID}/reject`)
  return result.ok
}
