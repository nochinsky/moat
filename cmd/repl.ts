import readline from "node:readline"

import * as log from "../lib/log.ts"
import { hashTree } from "../lib/hash.ts"
import type { EnvPaths } from "../lib/paths.ts"
import { SANDBOX_WORKDIR } from "../lib/pins.ts"
import { DEEPSEEK } from "../lib/provider.ts"
import { run } from "../lib/shell.ts"
import { readState, writeState, type EnvState } from "../sandbox/state.ts"
import { SANITIZED_GIT_ENV } from "../sync/copyin.ts"
import { fetchBranch, listSandboxBranches, sandboxWorktreeChanges, suggestBranch } from "../sync/copyout.ts"
import { detectChecks } from "../lib/detect.ts"
import { applyPlan, describePlan, planApply, type ApplyPlan } from "../sync/apply.ts"
import { runChecks } from "../sandbox/checks.ts"
import { computeCost, describeRate, isRetiredModel, usageOf } from "../lib/pricing.ts"
import {
  AnswerRenderer,
  colourEnabled,
  editDiff,
  formatError,
  makeTheme,
  outputLines,
  spinnerFrame,
  stripAnsi,
  toolLine,
  turnSummaryLine,
  type ToolCallView,
  type TurnSummary,
} from "./display.ts"
import {
  authHeaders,
  baseUrl,
  compact,
  connect,
  lastUserMessageID,
  listAgents,
  listModels,
  listSessions,
  promptBody,
  modelVariants,
  replyToQuestion,
  revert,
  unrevert,
  type Client,
  type ModelChoice,
  type QuestionInfo,
} from "./client.ts"

/**
 * moat's interactive session: watch the agent work, and talk to it while it does.
 *
 * Everything here is a thin client over the server running inside the sandbox.
 * The event stream gives the live view, `prompt_async` accepts a message at any
 * time — verified against the real server, which queues a second message rather
 * than rejecting it — and `abort` stops a turn.
 *
 * It replaces the previous behaviour of exec'ing opencode's own TUI, which meant
 * moat could not offer an interactive session unless you had installed opencode
 * on the host as well. The sandbox already runs the server; the CLI is just a
 * client of it.
 */

export type ReplOptions = {
  paths: EnvPaths
  state: EnvState
  password: string
  /** A task to start on immediately, rather than waiting for the first line. */
  firstMessage?: string
  showOutput?: boolean
  sessionID?: string
}

/**
 * Colour, decided once.
 *
 * These are plain strings rather than the theme's functions because most of
 * this file builds lines by interpolation, where nested calls read badly. They
 * are derived from `makeTheme` so the decision itself — NO_COLOR, FORCE_COLOR,
 * TERM=dumb, not a terminal — is made in exactly one place, and the codes match
 * the ones `cmd/display.ts` emits. `DIM` is bright black (90), not faint (2):
 * faint renders as nothing at all in a number of terminals, which silently
 * loses every piece of secondary information in the session.
 */
const theme = makeTheme(colourEnabled())
const COLOUR = theme.enabled
const BOLD = COLOUR ? "\u001b[1m" : ""
const DIM = COLOUR ? "\u001b[90m" : ""
const GREEN = COLOUR ? "\u001b[32m" : ""
const RED = COLOUR ? "\u001b[31m" : ""
const YELLOW = COLOUR ? "\u001b[33m" : ""
const RESET = COLOUR ? "\u001b[0m" : ""

/** How wide the terminal is, with a sane guess when it will not say. */
function terminalWidth(): number {
  const columns = process.stdout.columns
  return typeof columns === "number" && columns > 20 ? columns : 100
}

export async function runRepl(options: ReplOptions): Promise<number> {
  const client = await connect(options.state, options.password, SANDBOX_WORKDIR)

  let sessionID = options.sessionID ?? (await newestSession(client))
  let busy = false
  let typing = false // an assistant text block is open on the current line
  let exitCode = 0
  let closed = false
  // A question the agent asked, waiting for the user's next line. While this is
  // set, input is an answer rather than a new instruction.
  let pending: { requestID: string; questions: QuestionInfo[]; index: number; answers: string[][] } | null = null
  // `/apply` shows the plan and waits for one confirmation line, so applying is
  // never a single unconsidered keystroke.
  let pendingApply: ApplyPlan | null = null

  // --- what the next prompt will use -----------------------------------------
  // The model is the one this environment was booted with; the reasoning effort
  // and agent are remembered across restarts, because re-picking them every
  // time you open a session is the kind of friction that makes a tool annoying.
  let modelRef = options.state.model ?? `${DEEPSEEK.opencodeID}/${DEEPSEEK.defaultModel}`
  let effort: string | null = options.state.effort ?? DEEPSEEK.defaultEffort
  let agent = options.state.agent ?? undefined
  // Reasoning is streamed but hidden by default: it is long, and most of the
  // time you want the answer. `/thinking` turns it on.
  let showThinking = false
  let verbose = options.showOutput ?? false

  /**
   * Write a change back to the environment so the next `moat` in here sees it.
   *
   * Read-modify-write rather than a blind save of the snapshot this session
   * started with: `moat up` in another terminal may have rewritten the same
   * file since, and clobbering its fields with stale ones would be a lie.
   */
  const persist = (patch: Partial<Pick<EnvState, "model" | "effort" | "agent">>): void => {
    try {
      const current = readState(options.paths) ?? options.state
      Object.assign(current, patch)
      writeState(options.paths, current)
      options.state = current
    } catch {
      // A read-only state file must not take the session down with it.
      Object.assign(options.state, patch)
    }
  }

  const splitModel = (ref: string): { providerID: string; modelID: string } => {
    const slash = ref.indexOf("/")
    if (slash === -1) return { providerID: DEEPSEEK.opencodeID, modelID: ref }
    return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
  }

  const terminal = process.stdin.isTTY === true
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${BOLD}\u203a${RESET} `,
    terminal,
    historySize: 200,
  })

  /**
   * The one row that may be rewritten in place.
   *
   * Everything else moat prints is committed to scrollback and never touched
   * again, which is what makes the transcript safe to scroll and copy. A running
   * tool call is the exception: it starts as `⠹ bash npm test` and ends as
   * `✓ bash npm test 2.1s`, and printing those as two rows doubles the height of
   * every turn for no information. So the running row is retained, repainted
   * while it runs, and replaced in place on completion.
   *
   * The kind matters when it comes time to clear it. A finished tool row is part
   * of the record and is kept; a "thinking" row is a transient stand-in and is
   * erased, because leaving it behind would litter the transcript with a line
   * that says nothing once the answer has arrived.
   *
   * Repainting is only safe because such a row is kept to one terminal line —
   * see the width argument to `toolLine` — and because nothing else is written
   * while it is live.
   */
  let live: { text: string; kind: "tool" | "thinking" } | null = null
  /** True while readline's `› ` prompt occupies the current line. */
  let promptShowing = false

  /** Print the live row, or repaint it if one is already showing. */
  const drawLive = (text: string, kind: "tool" | "thinking"): void => {
    if (!terminal) {
      if (live === null) process.stdout.write(`${text}\n`)
      live = { text, kind }
      return
    }
    if (live === null) process.stdout.write("\n")
    else {
      readline.clearLine(process.stdout, 0)
      readline.cursorTo(process.stdout, 0)
    }
    process.stdout.write(text)
    live = { text, kind }
    promptShowing = false
  }

  /**
   * Get the current line ready for output, once.
   *
   * Called at the moment something is actually about to be written, never in
   * anticipation of it. That distinction is the whole point: the token stream
   * arrives in tiny fragments that the renderer buffers until a line is
   * complete, so clearing on every fragment would blank the spinner and leave
   * nothing in its place for as long as it takes the line to finish.
   *
   * Also idempotent, so a caller may invoke it before each write without
   * clearing the line it just wrote.
   */
  const beginOutput = (): void => {
    if (live) {
      const kind = live.kind
      live = null
      if (terminal) {
        readline.clearLine(process.stdout, 0)
        readline.cursorTo(process.stdout, 0)
        // A tool row is worth keeping, so end its line rather than erasing it.
        if (kind === "tool") process.stdout.write("\n")
      }
      promptShowing = false
    }
    if (promptShowing && terminal) {
      readline.clearLine(process.stdout, 0)
      readline.cursorTo(process.stdout, 0)
      promptShowing = false
    }
  }

  /** Draw the live row, or replace it if one is already showing. */
  const commitLive = (text: string, kind: "tool" | "thinking" = "tool"): void => {
    drawLive(text, kind)
    if (live) live.text = text
    if (kind === "tool") {
      live = null
      if (terminal) process.stdout.write("\n")
    }
  }

  /** Write a complete line without trampling whatever the user is typing. */
  const say = (text: string): void => {
    beginOutput()
    if (typing) {
      process.stdout.write("\n")
      typing = false
    }
    process.stdout.write(`${text}\n`)
    prompt()
  }

  /**
   * Streamed output, rendered a line at a time.
   *
   * The renderer owns the markdown and the gutter and decides when a line is
   * ready; this only gets the terminal into a state where writing is safe, and
   * only at the moment there is something to write.
   */
  const sink = (text: string): void => {
    beginOutput()
    process.stdout.write(text)
    typing = true
  }
  const answer = new AnswerRenderer(theme, sink)
  const reasoning = new AnswerRenderer(theme, sink, theme.thoughtGutter)

  /** Append streamed assistant text. */
  const stream = (chunk: string): void => answer.push(chunk)

  /** Append streamed reasoning. Dimmed and marked so it is never mistaken for the answer. */
  const streamThought = (chunk: string): void => reasoning.push(chunk)

  /** Close whichever block is open, so the next thing starts on its own line. */
  const endBlocks = (): void => {
    answer.flush()
    reasoning.flush()
    if (typing) {
      process.stdout.write("\n")
      typing = false
    }
  }

  // ---------------------------------------------------------------------------
  // the busy indicator
  // ---------------------------------------------------------------------------
  // One interval, running only while a turn is in flight, driving whichever row
  // is live: the running tool call if there is one, otherwise a "thinking" row
  // so a long silent turn does not look like a hang. Both are repainted in
  // place, and the thinking row is skipped entirely while the user has typed
  // something, because stealing the input line out from under someone mid-word
  // is far worse than a missing animation.
  let tick = 0
  let turnStarted = 0
  let spinner: NodeJS.Timeout | null = null

  const paint = (): void => {
    tick++
    const frame = spinnerFrame(tick)
    if (activeTool) {
      activeTool.spinner = frame
      drawLive(toolLine(activeTool, theme, terminalWidth()), "tool")
      return
    }
    if (rl.line !== "") return
    const elapsed = Date.now() - turnStarted
    if (elapsed < 1000) return
    drawLive(`  ${DIM}${frame} thinking ${Math.round(elapsed / 1000)}s${RESET}`, "thinking")
  }

  const startSpinner = (): void => {
    if (!terminal || spinner) return
    spinner = setInterval(paint, 100)
  }

  const stopSpinner = (): void => {
    if (!spinner) return
    clearInterval(spinner)
    spinner = null
  }

  const askQuestion = (request: { id: string; questions: QuestionInfo[] }): void => {
    beginOutput()
    pending = { requestID: request.id, questions: request.questions, index: 0, answers: [] }
    renderQuestion()
  }

  const renderQuestion = (): void => {
    if (!pending) return
    const current = pending.questions[pending.index]
    if (!current) return
    say("")
    say(`  ${YELLOW}?${RESET} ${BOLD}${current.question}${RESET}`)
    current.options.forEach((option, index) => {
      say(`    ${index + 1}. ${option.label.padEnd(18)} ${DIM}${option.description}${RESET}`)
    })
    const hints = [`a number 1-${current.options.length}`, "a label"]
    if (current.custom !== false) hints.push("or type your own answer")
    if (current.multiple) hints.push("(comma separated for several)")
    say(`  ${DIM}${hints.join(", ")}${RESET}`)
    if (pending.questions.length > 1) {
      say(`  ${DIM}question ${pending.index + 1} of ${pending.questions.length}${RESET}`)
    }
    prompt()
  }

  /** Turn the user's line into one answer for the current question. */
  const resolveQuestion = async (line: string): Promise<void> => {
    if (!pending) return
    const current = pending.questions[pending.index]
    if (!current) return
    const text = line.trim()

    if (text === "" && current.custom === false) {
      say("  pick one of the numbered options")
      return renderQuestion()
    }

    const parts = current.multiple ? text.split(",").map((p) => p.trim()) : [text]
    const resolved: string[] = []
    for (const part of parts) {
      if (part === "") continue
      const asNumber = Number.parseInt(part, 10)
      if (String(asNumber) === part && asNumber >= 1 && asNumber <= current.options.length) {
        resolved.push(current.options[asNumber - 1]!.label)
        continue
      }
      const byLabel = current.options.find((option) => option.label.toLowerCase() === part.toLowerCase())
      if (byLabel) {
        resolved.push(byLabel.label)
        continue
      }
      if (current.custom === false) {
        say(`  ${part} is not one of the options`)
        return renderQuestion()
      }
      resolved.push(part)
    }

    pending.answers.push(resolved.length > 0 ? resolved : [current.options[0]?.label ?? "no preference"])
    pending.index += 1

    if (pending.index < pending.questions.length) return renderQuestion()

    const { requestID, answers } = pending
    pending = null
    const ok = await replyToQuestion(options.state, options.password, requestID, answers)
    say(ok ? `  ${GREEN}answered${RESET}` : `  ${RED}could not deliver the answer${RESET}`)
  }

  const prompt = (): void => {
    if (!terminal || closed) return
    rl.prompt(true)
    promptShowing = true
  }

  // ---------------------------------------------------------------------------
  // live view
  // ---------------------------------------------------------------------------
  const controller = new AbortController()
  const subscription = await client.event.subscribe({ signal: controller.signal })

  const toolStatus = new Map<string, string>()
  /** When each call started, for the elapsed time shown when it finishes. */
  const startedAt = new Map<string, number>()
  /** The call currently occupying the live row, if any. */
  let activeTool: (ToolCallView & { status: string }) | null = null
  /**
   * Token and cost totals for the turn in flight, keyed by message id.
   *
   * `message.updated` fires repeatedly for the same message as its usage grows,
   * so this is a map and not a counter — summing the events would multiply the
   * turn's cost several times over.
   */
  let turnUsage = new Map<string, { tokens: unknown; at: number }>()
  let contextLimit: number | undefined
  /** Reasoning levels the current model accepts, as the server reports them. */
  let modelLevels: string[] = []

  const costOfTurn = (): TurnSummary => {
    let prompt = 0
    let cached = 0
    let output = 0
    let reasoningTokens = 0
    let usd = 0
    let known = true
    const { providerID, modelID } = splitModel(modelRef)
    void providerID
    for (const entry of turnUsage.values()) {
      const usage = usageOf(entry.tokens)
      prompt += usage.input
      cached += usage.cacheRead
      output += usage.output
      reasoningTokens += usage.reasoning
      const cost = computeCost(modelID, usage, new Date(entry.at))
      if (!cost.known) known = false
      usd += cost.usd
    }
    return {
      promptTokens: prompt + cached,
      cachedTokens: cached,
      outputTokens: output,
      reasoningTokens,
      usd,
      costKnown: known && turnUsage.size > 0,
      peak: describeRate() === "peak",
      tools: toolStatus.size,
      failed: [...toolStatus.values()].filter((s) => s === "error").length,
      ms: turnStarted > 0 ? Date.now() - turnStarted : 0,
      contextLimit,
    }
  }
  // Streaming text arrives as `message.part.delta`, which carries only a part
  // id — not whether that part is the answer, the model's reasoning, or the
  // user's own prompt echoed back. So the parts are catalogued from the
  // `message.part.updated` events that precede them, and the message ids from
  // `message.updated`. Verified against a live server: an assistant
  // `message.updated` always arrives before that message's first delta.
  const partKind = new Map<string, string>()
  const assistantMessages = new Set<string>()
  const startView = (async () => {
    try {
      for await (const event of subscription.stream) {
        const e = event as { type?: string; properties?: Record<string, unknown> }
        const props = e.properties ?? {}
        if (props.sessionID && props.sessionID !== sessionID) continue

        if (e.type === "message.updated") {
          const info = props.info as
            | { id?: string; role?: string; tokens?: unknown; time?: { created?: number; completed?: number } }
            | undefined
          if (info?.role === "assistant" && info.id) {
            assistantMessages.add(info.id)
            // Billed tokens, not an estimate: these are what the provider
            // reported for the message, so the turn total is the real one.
            turnUsage.set(info.id, { tokens: info.tokens, at: info.time?.completed ?? Date.now() })
          }
          continue
        }

        // The actual stream. Without this the answer never appears: the
        // `delta` field is not carried on `message.part.updated`, so waiting
        // for it there means printing nothing at all until the turn ends.
        if (e.type === "message.part.delta") {
          const { partID, messageID, delta } = props as { partID?: string; messageID?: string; delta?: string }
          if (typeof delta !== "string" || delta.length === 0) continue
          if (messageID && !assistantMessages.has(messageID)) continue
          const kind = partID ? partKind.get(partID) : undefined
          if (kind === "text") stream(delta)
          else if (kind === "reasoning" && showThinking) streamThought(delta)
          continue
        }

        if (e.type === "message.part.updated") {
          const part = props.part as
            | { id?: string; type?: string; text?: string; tool?: string; callID?: string; state?: Record<string, unknown> }
            | undefined
          if (!part) continue
          if (part.id && part.type) partKind.set(part.id, part.type)

          if (part.type === "tool" && part.tool) {
            const status = String(part.state?.status ?? "")
            if (status === "pending") continue
            const key = part.callID ?? part.tool
            if (toolStatus.get(key) === status) continue
            toolStatus.set(key, status)
            const title = stripAnsi(String(part.state?.title ?? "")).split("\n")[0] ?? ""

            if (status === "running") {
              // Retain the row and repaint it; see `live`.
              activeTool = { tool: part.tool, status, title, spinner: spinnerFrame(tick) }
              startedAt.set(key, Date.now())
              drawLive(toolLine(activeTool, theme, terminalWidth()), "tool")
              busy = true
              continue
            }

            const begin = startedAt.get(key)
            const view = activeTool && activeTool.tool === part.tool
              ? activeTool
              : { tool: part.tool, status, title }
            view.status = status
            view.title = title
            if (begin !== undefined) view.ms = Date.now() - begin

            // Show what an edit actually did, rather than just its filename.
            const input = part.state?.input as { filePath?: string; oldString?: string; newString?: string; content?: string } | undefined
            if (status === "completed" && input && (part.tool === "edit" || part.tool === "write")) {
              const diff = editDiff(
                part.tool === "write" ? "" : input.oldString,
                part.tool === "write" ? input.content : input.newString,
                theme,
              )
              view.added = diff.added
              view.removed = diff.removed
              if (verbose) {
                commitLive(toolLine(view, theme, terminalWidth()))
                for (const line of diff.lines) say(line)
                activeTool = null
                continue
              }
            }

            commitLive(toolLine(view, theme, terminalWidth()))
            activeTool = null

            if (status === "error") {
              const detail = stripAnsi(formatError(part.state?.error ?? part.state?.output))
              say(`      ${RED}${detail.split("\n")[0] ?? "failed"}${RESET}`)
              exitCode = 1
            } else if (verbose) {
              const out = stripAnsi(String(part.state?.output ?? ""))
              if (out.trim() !== "") for (const line of outputLines(out, theme)) say(line)
            }
          }
          continue
        }

        if (e.type === "question.asked") {
          const request = (props as { request?: { id: string; questions: QuestionInfo[] } }).request ??
            (props as unknown as { id: string; questions: QuestionInfo[] })
          if (request?.id && Array.isArray(request.questions) && props.sessionID === sessionID) {
            askQuestion(request)
          } else if (request?.id && Array.isArray(request.questions)) {
            askQuestion(request)
          }
          continue
        }

        if (e.type === "question.rejected") {
          pending = null
          say(`  ${DIM}the question was dismissed${RESET}`)
          continue
        }

        if (e.type === "session.idle") {
          stopSpinner()
          endBlocks()
          // Commit a running row that never reported a finish, rather than
          // leaving it on screen looking like it is still going.
          if (activeTool) {
            commitLive(toolLine({ ...activeTool, status: "completed" }, theme, terminalWidth()))
            activeTool = null
          }
          busy = false
          const summary = costOfTurn()
          if (summary.tools > 0 || summary.outputTokens > 0) say(turnSummaryLine(summary, theme))
          prompt()
          continue
        }

        if (e.type === "session.error") {
          stopSpinner()
          endBlocks()
          say(`${RED}session error:${RESET} ${stripAnsi(formatError(props.error ?? props)).slice(0, 300)}`)
          busy = false
        }
      }
    } catch (error) {
    }
  })()

  // ---------------------------------------------------------------------------
  // sending
  // ---------------------------------------------------------------------------
  const send = async (text: string): Promise<void> => {
    if (!sessionID) sessionID = await createSession(client)
    const { providerID, modelID } = splitModel(modelRef)
    // A turn's numbers are per-turn, so everything that accumulates is reset
    // here rather than at the end, so a turn that never reports idle cannot
    // leak its totals into the next one.
    turnUsage = new Map()
    toolStatus.clear()
    startedAt.clear()
    activeTool = null
    turnStarted = Date.now()
    busy = true
    startSpinner()
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        // `effort` is opencode's "variant"; see `promptBody` for why it does not
        // appear in the SDK's own body type.
        body: promptBody({ prompt: text, providerID, modelID, agent, variant: effort ?? undefined }),
      })
    } catch (error) {
      stopSpinner()
      busy = false
      say(`${RED}could not send:${RESET} ${(error as Error).message}`)
    }
  }

  /**
   * The context window of the current model, for the usage proportion in the
   * turn summary. Fetched once and refreshed when the model changes; a failure
   * here is not worth reporting, the summary simply omits the proportion.
   */
  /**
   * Learn what the current model is, once, and check the effort against it.
   *
   * Two things come back from the same call: the context window for the turn
   * summary, and the reasoning levels this model actually accepts. The second
   * matters because moat now starts with an effort chosen for it — `high` — and
   * a custom endpoint, or a model that simply has no levels, would otherwise
   * carry a setting that does nothing while `/status` reported it as active.
   *
   * Runs at startup and again on every `/model`, so switching is checked the
   * same way booting is.
   */
  const refreshModelInfo = async (): Promise<void> => {
    try {
      const { providerID, modelID } = splitModel(modelRef)
      const models = await listModels(client)
      const model = models.find((m) => m.providerID === providerID && m.id === modelID)
      contextLimit = model?.context || undefined
      modelLevels = model?.variants ?? []
    } catch {
      contextLimit = undefined
      modelLevels = []
    }
    if (!effort) return
    if (modelLevels.includes(effort)) return

    const dropped = effort
    effort = null
    persist({ effort })
    // Silent when the model has no levels at all — a custom endpoint reached
    // with --base-url, where there is no effort concept to have an opinion
    // about and the notice would be noise on every startup. Only worth saying
    // when the model does have levels and this one is not among them.
    if (modelLevels.length > 0) {
      say(
        `  ${YELLOW}${modelRef} does not take "${dropped}", so moat will not set an effort.${RESET}` +
          `  ${DIM}this model takes: ${modelLevels.join(", ")}${RESET}`,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // slash commands
  // ---------------------------------------------------------------------------
  const commands: Record<string, { help: string; run: (args: string) => Promise<void> | void }> = {
    help: {
      help: "this list",
      run: () => {
        say("")
        say("  type anything to send it to the agent. It queues if the agent is mid-turn.")
        say("")
        for (const [name, cmd] of Object.entries(commands)) {
          say(`  ${BOLD}/${name.padEnd(9)}${RESET} ${cmd.help}`)
        }
        say("")
      },
    },
    stop: {
      help: "abort the turn the agent is running",
      run: async () => {
        if (!sessionID) return say("nothing running")
        await client.session.abort({ path: { id: sessionID } }).catch(() => undefined)
        busy = false
        say(`${YELLOW}stopped${RESET}`)
      },
    },
    diff: {
      help: "everything the agent has changed since it started",
      run: async () => {
        const base = options.state.baseBranch
        const branch = options.state.branch
        const sections: string[] = []

        if (base && branch) {
          const commits = await run(
            "git",
            ["-C", options.paths.work, "log", "--oneline", `${base}..${branch}`],
            { env: SANITIZED_GIT_ENV, allowFailure: true },
          )
          const stat = await run(
            "git",
            ["-C", options.paths.work, "diff", "--stat", base, branch],
            { env: SANITIZED_GIT_ENV, allowFailure: true },
          )
          if (commits.stdout.trim()) sections.push(commits.stdout.trimEnd())
          if (stat.stdout.trim()) sections.push(stat.stdout.trimEnd())
        }

        const uncommitted = await sandboxWorktreeChanges(options.paths)
        if (uncommitted.length > 0) {
          const stat = await run("git", ["-C", options.paths.work, "diff", "--stat", "HEAD"], {
            env: SANITIZED_GIT_ENV,
            allowFailure: true,
          })
          const lines = [`uncommitted (not fetched by moat fetch):`]
          if (stat.stdout.trim()) lines.push(stat.stdout.trimEnd())
          for (const entry of uncommitted.filter((l) => l.startsWith("??"))) {
            lines.push(`  new file: ${entry.slice(3)}`)
          }
          sections.push(lines.join("\n"))
        }

        if (sections.length === 0) return say("nothing changed yet")
        say("")
        for (const section of sections) {
          for (const line of section.split("\n")) say(`  ${line}`)
          say("")
        }
      },
    },
    take: {
      help: "bring the agent's branch onto the host and show it",
      run: async () => {
        const branches = await listSandboxBranches(options.paths)
        if (branches.length === 0) return say("nothing committed yet")
        const target = await suggestBranch(options.paths)
        if (!target) return say("could not work out which branch to take")
        const before = hashTree(options.paths.projectDir)
        const fetched = await fetchBranch(options.paths, target)
        const after = hashTree(options.paths.projectDir)
        say("")
        say(`  ${BOLD}${target}${RESET}  ${fetched.commits} commit(s), ${fetched.sha.slice(0, 12)}`)
        for (const commit of fetched.commitsFetched.slice(0, 10)) {
          say(`    ${DIM}${commit.sha.slice(0, 10)}${RESET}  ${commit.subject}`)
        }
        say("")
        say(`  working tree ${before.digest === after.digest ? `${GREEN}untouched${RESET}` : `${RED}changed${RESET}`}`)
        say(`  accept:  ${BOLD}moat apply ${target} --checkout${RESET}`)
        say(`  reject:  git update-ref -d ${fetched.hostRef}`)
      },
    },
    status: {
      help: "model, effort, branch, session and credential time left",
      run: () => {
        const expires = options.state.credential?.expiresAt
        const left = expires ? Math.round((new Date(expires).getTime() - Date.now()) / 1000) : null
        say("")
        say(`  project     ${options.paths.projectDir}`)
        say(`  endpoint    ${baseUrl(options.state)}`)
        say(`  model       ${modelRef}${effort ? `  ${DIM}(effort ${effort})${RESET}` : ""}`)
        say(`  agent       ${agent ?? `${DIM}default${RESET}`}`)
        say(`  thinking    ${showThinking ? "shown" : `${DIM}hidden${RESET}`}`)
        say(`  branch      ${options.state.branch ?? "unknown"}`)
        say(`  session     ${sessionID ?? "none yet"}`)
        say(`  profiles    ${options.state.profiles?.join(", ") || "base only"}`)
        if (left !== null) say(`  credential  ${left > 0 ? `${left}s left` : `${RED}expired${RESET}`}`)
        say("")
      },
    },
    model: {
      help: "show or change the model: /model [name]",
      run: async (args) => {
        const models = await listModels(client)
        if (models.length === 0) return say("the server reported no models; is the credential still valid?")
        const wanted = args.trim()

        if (wanted === "") {
          say("")
          // Width from the data, so a long id cannot push the columns apart.
          const width = Math.max(...models.map((m) => `${m.providerID}/${m.id}`.length), 20)
          models.forEach((m, index) => {
            const ref = `${m.providerID}/${m.id}`
            const mark = ref === modelRef ? `${GREEN}\u203a${RESET}` : " "
            const effortNote = m.variants.length > 0 ? `  ${DIM}effort: ${m.variants.join(" ")}${RESET}` : ""
            // DeepSeek still accepts the old names but has retired the models
            // behind them: requests go to the current Flash model and are billed
            // at its price. Listing them as though they were four live models
            // would be a quiet lie, so they are marked.
            const retired = isRetiredModel(m.id) ? `  ${YELLOW}retired name${RESET}` : ""
            say(`  ${mark} ${String(index + 1).padStart(2)}. ${ref.padEnd(width)}  ${DIM}${formatContext(m)}${RESET}${effortNote}${retired}`)
          })
          say("")
          if (effort) say(`  ${DIM}effort for this session: ${effort}${RESET}`)
          say(`  ${DIM}retired names still work but are served by the current flash model${RESET}`)
          say(`  switch with ${BOLD}/model <number or name>${RESET}`)
          return
        }

        const byNumber = /^\d+$/.test(wanted) ? models[Number(wanted) - 1] : undefined
        const chosen =
          byNumber ??
          models.find((m) => `${m.providerID}/${m.id}` === wanted) ??
          models.find((m) => m.id === wanted) ??
          models.find((m) => m.id.toLowerCase().includes(wanted.toLowerCase()))

        if (!chosen) return say(`no model matches "${wanted}". ${BOLD}/model${RESET} lists them.`)

        modelRef = `${chosen.providerID}/${chosen.id}`
        // An effort the new model does not have would be ignored silently, which
        // is worse than dropping it: say so.
        let dropped: string | null = null
        if (effort && !chosen.variants.includes(effort)) {
          dropped = effort
          effort = null
        }
        persist({ model: modelRef, effort })
        await refreshModelInfo()
        say(`model is now ${BOLD}${modelRef}${RESET}`)
        if (dropped) {
          say(`  ${YELLOW}effort "${dropped}" is not available on this model, so it was cleared${RESET}`)
          if (chosen.variants.length > 0) say(`  ${DIM}this model takes: ${chosen.variants.join(", ")}  (/think <level>)${RESET}`)
        }
        say(`  ${DIM}takes effect on the next message${RESET}`)
      },
    },
    think: {
      help: "reasoning effort: /think [level]",
      run: async (args) => {
        const { providerID, modelID } = splitModel(modelRef)
        const levels = await modelVariants(client, providerID, modelID)
        const wanted = args.trim().toLowerCase()

        if (levels.length === 0) {
          return say(`${modelRef} does not expose reasoning effort levels; there is nothing to set.`)
        }

        if (wanted === "") {
          say("")
          for (const level of levels) {
            const mark = level === effort ? `${GREEN}\u203a${RESET}` : " "
            const notes: string[] = []
            if (level === "off") notes.push("answer without thinking")
            if (level === DEEPSEEK.defaultEffort) notes.push("moat's default")
            const note = notes.length > 0 ? `  ${DIM}${notes.join("; ")}${RESET}` : ""
            say(`  ${mark} ${BOLD}${level}${RESET}${note}`)
          }
          say("")
          const hint = effort === DEEPSEEK.defaultEffort
            ? `  set with ${BOLD}/think <level>${RESET}`
            : `  set with ${BOLD}/think <level>${RESET}, or ${BOLD}/think default${RESET} to go back to ${DEEPSEEK.defaultEffort}`
          say(hint)
          return
        }

        // Only `default` clears. `off` used to be an alias for this, from before
        // moat exposed DeepSeek's thinking switch; it is now a real level meaning
        // "do not think at all", and treating it as "unset" silently turned the
        // one setting a user would reach for into the opposite of itself.
        if (wanted === "default") {
          effort = DEEPSEEK.defaultEffort
          persist({ effort })
          return say(`effort is back to moat's default, ${BOLD}${DEEPSEEK.defaultEffort}${RESET}`)
        }

        if (!levels.includes(wanted)) {
          return say(`"${wanted}" is not one of ${levels.join(", ")} for ${modelRef}`)
        }

        effort = wanted
        persist({ effort })
        say(`effort is now ${BOLD}${wanted}${RESET} ${DIM}(applies to the next message)${RESET}`)
      },
    },
    thinking: {
      help: "show or hide the model's reasoning as it streams",
      run: () => {
        showThinking = !showThinking
        say(showThinking ? `showing reasoning ${DIM}(/thinking to hide)${RESET}` : "hiding reasoning")
      },
    },
    agent: {
      help: "show or change the agent: /agent [name]",
      run: async (args) => {
        const agents = await listAgents(client)
        const primaries = agents.filter((a) => a.mode !== "subagent")
        const wanted = args.trim()

        if (wanted === "") {
          if (primaries.length === 0) return say("the server reported no agents")
          say("")
          for (const a of primaries) {
            const mark = a.name === agent ? `${GREEN}\u203a${RESET}` : " "
            say(`  ${mark} ${BOLD}${a.name.padEnd(12)}${RESET} ${DIM}${(a.description ?? "").slice(0, 70)}${RESET}`)
          }
          const mark = agent === undefined ? `${GREEN}\u203a${RESET}` : " "
          say(`  ${mark} ${DIM}default${RESET}`)
          say("")
          say(`  switch with ${BOLD}/agent <name>${RESET}`)
          return
        }

        if (wanted === "default" || wanted === "off") {
          agent = undefined
          persist({ agent: null })
          return say("using the default agent")
        }

        const chosen = primaries.find((a) => a.name === wanted) ?? primaries.find((a) => a.name.startsWith(wanted))
        if (!chosen) return say(`no agent named "${wanted}". ${BOLD}/agent${RESET} lists them.`)
        agent = chosen.name
        persist({ agent })
        say(`agent is now ${BOLD}${chosen.name}${RESET} ${DIM}(applies to the next message)${RESET}`)
      },
    },
    compact: {
      help: "summarise the session so far, to free up context",
      run: async () => {
        if (!sessionID) return say("nothing to compact yet")
        const { providerID, modelID } = splitModel(modelRef)
        say("compacting...")
        const ok = await compact(client, sessionID, providerID, modelID)
        say(ok ? `${GREEN}compacted${RESET}` : `${RED}compaction failed${RESET}`)
      },
    },
    undo: {
      help: "roll the conversation back to before your last message",
      run: async () => {
        if (!sessionID) return say("nothing to undo yet")
        const messageID = await lastUserMessageID(client, sessionID)
        if (!messageID) return say("no messages to undo")
        const ok = await revert(client, sessionID, messageID)
        say(ok ? `${GREEN}undone${RESET}  ${DIM}(/redo to put it back)${RESET}` : `${RED}could not undo${RESET}`)
      },
    },
    redo: {
      help: "put back a turn removed with /undo",
      run: async () => {
        if (!sessionID) return say("nothing to redo")
        const ok = await unrevert(client, sessionID)
        say(ok ? `${GREEN}restored${RESET}` : `${RED}nothing to restore${RESET}`)
      },
    },
    verbose: {
      help: "show or hide tool output",
      run: () => {
        verbose = !verbose
        say(verbose ? "showing tool output" : "hiding tool output")
      },
    },
    sessions: {
      help: "list past sessions in this environment",
      run: async () => {
        const sessions = await listSessions(client)
        if (sessions.length === 0) return say("no sessions yet")
        say("")
        for (const s of sessions.slice(0, 15)) {
          const marker = s.id === sessionID ? `${GREEN}\u203a${RESET}` : " "
          say(`  ${marker} ${s.id}  ${DIM}${(s.title ?? "").slice(0, 60)}${RESET}`)
        }
        say("")
        say(`  switch with ${BOLD}/use <id>${RESET}`)
      },
    },
    use: {
      help: "switch to another session: /use <id>",
      run: (args) => {
        const id = args.trim()
        if (!id) return say("usage: /use <session-id>  (see /sessions)")
        sessionID = id
        say(`now on ${id}`)
      },
    },
    new: {
      help: "start a fresh session",
      run: async () => {
        sessionID = await createSession(client)
        say(`new session ${sessionID}`)
      },
    },
    shell: {
      help: "open a shell inside the sandbox (ctrl-d to come back)",
      run: async () => {
        const { spawn } = await import("node:child_process")
        const { writeInnerScript, writeOuterScript, unshareArgs, sandboxEnv } = await import("../sandbox/launcher.ts")
        writeInnerScript(
          options.paths,
          `#!/bin/sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
cd ${SANDBOX_WORKDIR}
echo "[moat] inside the sandbox. ctrl-d returns to the moat prompt."
exec /bin/bash -l
`,
        )
        const boot = writeOuterScript(options.paths)
        rl.pause()
        await new Promise<void>((resolve) => {
          const child = spawn("unshare", unshareArgs(boot), { stdio: "inherit", env: sandboxEnv() })
          child.on("close", () => resolve())
          child.on("error", () => resolve())
        })
        rl.resume()
        say("back in moat")
      },
    },
    apply: {
      help: "merge the agent's work into your directory (asks first)",
      run: async () => {
        const plan = await planApply(options.paths)
        if (plan.empty) return say("nothing to apply: your directory already matches the sandbox")
        say("")
        for (const line of describePlan(plan)) say(`  ${line}`)
        for (const conflict of plan.conflicts) {
          say(`  ${YELLOW}skip${RESET}    ${conflict.path}  ${DIM}${conflict.note ?? "conflict"}${RESET}`)
        }
        say("")
        if (plan.conflicts.length > 0) {
          say(`  ${YELLOW}${plan.conflicts.length} file(s) changed on both sides and cannot be merged.${RESET}`)
          say(`  ${DIM}those are left exactly as they are; the rest can still go in${RESET}`)
        }
        pendingApply = plan
        say(`  apply ${plan.changes.length - plan.conflicts.length} change(s) to ${options.paths.projectDir}?`)
        say(`  ${DIM}type "yes" to apply, anything else to cancel${RESET}`)
        prompt()
      },
    },
    verify: {
      help: "run the project's own tests against the agent's work",
      run: async () => {
        const checks = detectChecks(options.paths.projectDir)
        if (checks.length === 0) return say("no test, lint or typecheck command found for this project")
        say(`running ${checks.map((c) => c.command).join(", ")} inside the sandbox...`)
        const results = await runChecks(options.paths, checks, { onOutput: () => undefined })
        say("")
        for (const result of results) {
          const mark = result.ok ? `${GREEN}pass${RESET}` : `${RED}FAIL${RESET}`
          say(`  ${mark}  ${result.label}  ${DIM}(${(result.ms / 1000).toFixed(1)}s)${RESET}`)
          if (!result.ok) {
            for (const line of result.output.split("\n").slice(-8)) say(`        ${DIM}${line}${RESET}`)
          }
        }
        say("")
      },
    },
    quit: { help: "leave (the sandbox keeps running)", run: () => rl.close() },
  }
  commands.exit = commands.quit!

  const handle = async (line: string): Promise<void> => {
    const text = line.trim()
    if (text.length === 0) return prompt()

    // A question is waiting, so this line is the answer to it.
    if (pendingApply) {
      const plan = pendingApply
      pendingApply = null
      if (!/^y(es)?$/i.test(text)) return say("cancelled; nothing was written")
      const result = await applyPlan(options.paths, plan)
      say(`  ${GREEN}applied ${result.applied} change(s)${RESET} to ${options.paths.projectDir}`)
      if (result.skipped.length > 0) say(`  ${YELLOW}left alone:${RESET} ${result.skipped.join(", ")}`)
      return prompt()
    }

    if (pending) {
      if (text === "/stop" || text === "/skip") {
        pending = null
        if (sessionID) await client.session.abort({ path: { id: sessionID } }).catch(() => undefined)
        busy = false
        say(`  ${YELLOW}question dismissed${RESET}  ${DIM}(the turn was stopped; ask again to continue)${RESET}`)
        return prompt()
      }
      return resolveQuestion(text)
    }

    if (text.startsWith("/")) {
      const [name, ...rest] = text.slice(1).split(" ")
      const command = commands[name ?? ""]
      if (!command) {
        say(`unknown command /${name}. try ${BOLD}/help${RESET}`)
        return prompt()
      }
      await command.run(rest.join(" "))
      return prompt()
    }

    if (busy) say(`${DIM}queued \u2014 the agent will pick this up when the current step finishes${RESET}`)
    await send(text)
  }

  rl.on("line", (line) => {
    void handle(line).catch((error) => say(`${RED}${(error as Error).message}${RESET}`))
  })
  rl.on("SIGINT", () => {
    if (busy && sessionID) {
      void client.session
        .abort({ path: { id: sessionID } })
        .catch(() => undefined)
        .then(() => {
          busy = false
          say(`${YELLOW}stopped${RESET}  ${DIM}(ctrl-c again to leave)${RESET}`)
        })
      return
    }
    rl.close()
  })
  rl.on("close", () => {
    closed = true
    stopSpinner()
    controller.abort()
  })

  // ---------------------------------------------------------------------------
  // Learn the context window before the banner, so the first turn summary can
  // show how full the window is.
  await refreshModelInfo()
  const effortLabel = effort ? ` \u00b7 effort ${effort}` : ""
  say("")
  say(`${BOLD}moat${RESET} ${DIM}\u00b7 ${modelRef}${effortLabel} \u00b7 ${options.paths.projectDir}${RESET}`)
  say(`${DIM}type a task and press enter. /help for commands, ctrl-c to interrupt.${RESET}`)
  say("")
  prompt()

  if (options.firstMessage && options.firstMessage.trim().length > 0) {
    say(`${DIM}\u203a ${options.firstMessage}${RESET}`)
    void send(options.firstMessage)
  }

  await new Promise<void>((resolve) => rl.on("close", () => resolve()))
  await startView.catch(() => undefined)
  return exitCode
}

async function newestSession(client: Client): Promise<string | undefined> {
  const sessions = await listSessions(client)
  return sessions[0]?.id
}

/** `1000000` is unreadable; `1M` is not. */
function formatContext(model: ModelChoice): string {
  const tokens = (n: number): string => {
    if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`
    return String(n)
  }
  const parts: string[] = []
  if (model.context > 0) parts.push(`${tokens(model.context)} ctx`)
  if (!model.toolCall) parts.push("no tools")
  if (model.reasoning) parts.push("reasoning")
  return parts.join(" · ")
}

async function createSession(client: Client): Promise<string> {
  const created = await client.session.create({ body: { title: "moat session" } })
  const data = created.data as { id?: string } | undefined
  if (!data?.id) throw new Error(`could not create a session: ${JSON.stringify(created.error ?? created)}`)
  return data.id
}

export { authHeaders, log }
