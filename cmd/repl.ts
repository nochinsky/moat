import readline from "node:readline"

import * as log from "../lib/log.ts"
import { hashTree } from "../lib/hash.ts"
import type { EnvPaths } from "../lib/paths.ts"
import { SANDBOX_WORKDIR } from "../lib/pins.ts"
import { run } from "../lib/shell.ts"
import type { EnvState } from "../sandbox/state.ts"
import { SANITIZED_GIT_ENV } from "../sync/copyin.ts"
import { fetchBranch, listSandboxBranches, sandboxWorktreeChanges, suggestBranch } from "../sync/copyout.ts"
import { detectChecks } from "../lib/detect.ts"
import { applyPlan, describePlan, planApply, type ApplyPlan } from "../sync/apply.ts"
import { runChecks } from "../sandbox/checks.ts"
import {
  authHeaders,
  baseUrl,
  connect,
  listSessions,
  replyToQuestion,
  type Client,
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

const DIM = "\u001b[2m"
const BOLD = "\u001b[1m"
const GREEN = "\u001b[32m"
const RED = "\u001b[31m"
const YELLOW = "\u001b[33m"
const RESET = "\u001b[0m"

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

  const terminal = process.stdin.isTTY === true
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${BOLD}\u203a${RESET} `,
    terminal,
    historySize: 200,
  })

  /** Write a complete line without trampling whatever the user is typing. */
  const say = (text: string): void => {
    if (typing) {
      process.stdout.write("\n")
      typing = false
    }
    if (terminal) {
      readline.clearLine(process.stdout, 0)
      readline.cursorTo(process.stdout, 0)
    }
    process.stdout.write(`${text}\n`)
    if (terminal && !closed) rl.prompt(true)
  }

  /** Append streamed assistant text to the open line. */
  const stream = (chunk: string): void => {
    if (!typing) {
      if (terminal) {
        readline.clearLine(process.stdout, 0)
        readline.cursorTo(process.stdout, 0)
      }
      process.stdout.write(`${DIM}\u2502${RESET} `)
      typing = true
    }
    process.stdout.write(chunk.replace(/\n(?!$)/g, `\n${DIM}\u2502${RESET} `))
  }

  const askQuestion = (request: { id: string; questions: QuestionInfo[] }): void => {
    if (terminal) {
      readline.clearLine(process.stdout, 0)
      readline.cursorTo(process.stdout, 0)
    }
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
    if (terminal && !closed) rl.prompt(true)
  }

  // ---------------------------------------------------------------------------
  // live view
  // ---------------------------------------------------------------------------
  const controller = new AbortController()
  const subscription = await client.event.subscribe({ signal: controller.signal })

  const toolStatus = new Map<string, string>()
  const startView = (async () => {
    try {
      for await (const event of subscription.stream) {
        const e = event as { type?: string; properties?: Record<string, unknown> }
        const props = e.properties ?? {}
        if (props.sessionID && props.sessionID !== sessionID) continue

        if (e.type === "message.part.updated") {
          const part = props.part as
            | { type?: string; text?: string; tool?: string; callID?: string; state?: Record<string, unknown> }
            | undefined
          if (!part) continue

          if (part.type === "text" && typeof props.delta === "string") {
            stream(props.delta)
            continue
          }

          if (part.type === "tool" && part.tool) {
            const status = String(part.state?.status ?? "")
            if (status === "pending") continue
            const key = part.callID ?? part.tool
            if (toolStatus.get(key) === status) continue
            toolStatus.set(key, status)
            const title = String(part.state?.title ?? "").split("\n")[0]?.slice(0, 90) ?? ""
            if (status === "running") {
              say(`  ${DIM}\u00b7 ${part.tool.padEnd(9)}${RESET} ${DIM}${title}${RESET}`)
              busy = true
            } else if (status === "completed") {
              say(`  ${GREEN}\u2713${RESET} ${part.tool.padEnd(9)} ${title}`)
              if (options.showOutput) {
                const out = String(part.state?.output ?? "").trimEnd()
                for (const line of out.split("\n").slice(0, 12)) say(`      ${DIM}${line}${RESET}`)
              }
            } else if (status === "error") {
              say(`  ${RED}\u2717${RESET} ${part.tool.padEnd(9)} ${title}`)
              say(`      ${RED}${String(part.state?.error ?? "").split("\n")[0]}${RESET}`)
              exitCode = 1
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
          if (typing) {
            process.stdout.write("\n")
            typing = false
          }
          busy = false
          prompt()
          continue
        }

        if (e.type === "session.error") {
          say(`${RED}session error:${RESET} ${JSON.stringify(props.error ?? props).slice(0, 300)}`)
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
    const [providerID = "moat", ...rest] = (options.state.model ?? "moat/model").split("/")
    busy = true
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          model: { providerID, modelID: rest.join("/") || "model" },
          parts: [{ type: "text", text }],
        },
      })
    } catch (error) {
      busy = false
      say(`${RED}could not send:${RESET} ${(error as Error).message}`)
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
      help: "model, branch, session and credential time left",
      run: () => {
        const expires = options.state.credential?.expiresAt
        const left = expires ? Math.round((new Date(expires).getTime() - Date.now()) / 1000) : null
        say("")
        say(`  project     ${options.paths.projectDir}`)
        say(`  endpoint    ${baseUrl(options.state)}`)
        say(`  model       ${options.state.model ?? "unknown"}`)
        say(`  branch      ${options.state.branch ?? "unknown"}`)
        say(`  session     ${sessionID ?? "none yet"}`)
        say(`  profiles    ${options.state.profiles?.join(", ") || "base only"}`)
        if (left !== null) say(`  credential  ${left > 0 ? `${left}s left` : `${RED}expired${RESET}`}`)
        say("")
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
    controller.abort()
  })

  // ---------------------------------------------------------------------------
  say("")
  say(`${BOLD}moat${RESET} ${DIM}\u00b7 ${options.state.model ?? "no model"} \u00b7 ${options.paths.projectDir}${RESET}`)
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

async function createSession(client: Client): Promise<string> {
  const created = await client.session.create({ body: { title: "moat session" } })
  const data = created.data as { id?: string } | undefined
  if (!data?.id) throw new Error(`could not create a session: ${JSON.stringify(created.error ?? created)}`)
  return data.id
}

export { authHeaders, log }
