import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import * as log from "../lib/log.ts"
import { hashTree } from "../lib/hash.ts"
import { stripAnsi } from "../lib/terminal.ts"
import { sandboxGit } from "../lib/git.ts"
import { PACKAGE_ROOT } from "../lib/paths.ts"

/**
 * `moat demo` — the pitch, runnable on your own machine.
 *
 * The product claim is not "a sandbox". It is that moat can tell the difference between *the
 * agent changed this*, *you changed this*, and *you both changed this, so nothing was written*,
 * because it recorded a baseline before the agent started and keeps three trees apart:
 *
 *   base    what moat copied in          (refs/moat/baseline in the sandbox)
 *   theirs  what the agent has now       (the sandbox working tree)
 *   mine    what you have now            (the host directory)
 *
 * This runs that end to end, keyless, with no configuration: it writes a small project to a
 * scratch directory, makes one change of its own (standing in for you), boots a real sandbox,
 * drives the **real pinned Codex** against the same keyless stub the test suites use so the
 * agent makes real edits with real tools, then plans and applies the result.
 *
 * Two rules this file follows, because breaking either would make the demo a puppet show:
 *
 *  1. **It performs the scenarios, it does not print them.** The three classifications are not
 *     asserted or chosen; the fixture is arranged so that the real trees produce them, and every
 *     line of attribution printed below comes back from `planApply` (`sync/apply.ts`). There is
 *     no second copy of the classification here. If `planApply` stopped distinguishing these
 *     cases, this would print something else and `test/e2e-demo.sh` would fail.
 *  2. **It reports the host tree's digest before and after**, so "nothing crossed back until you
 *     said so" is a measurement rather than a sentence.
 *
 * The agent is a stub model, and that is stated rather than hidden: the box, the runtime, the
 * tools, the commits, the fetch and the merge are real, and the *decisions* are somebody else's
 * by design. What is being demonstrated is the harness around the model, which is the part moat
 * owns.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))

export type DemoOptions = {
  /** Where to build the demo project. A scratch directory when not given. */
  dir?: string
  /** Keep the directory and the environment afterwards, for poking at. */
  keep?: boolean
  /** Seconds for the agent turn. */
  timeoutSeconds?: number
}

type Step = { name: string; ms: number }

export type DemoResult = {
  dir: string
  steps: Step[]
  /** Digests of the host project tree, before the agent ran and after everything was applied. */
  digestBefore: string
  digestAfter: string
  /** What the plan said, as the real code classified it. */
  classification: { path: string; verdict: string; detail: string }[]
  exported: string[]
  /**
   * What was missing from the cache when this run started.
   *
   * Recorded at the start, not inferred at the end: by the time the demo finishes it has filled
   * the cache, so asking afterwards always answers "warm" and the footer then describes a run
   * that did not happen. Measured — a cold run that took 56.7s reported "(warm cache)".
   */
  coldCache: string[]
}

/** The files the demo project starts as, before the agent or "you" touch anything. */
const FIXTURE: Record<string, string> = {
  "package.json": `{
  "name": "moat-demo-project",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
`,
  "app.js": `// A file the agent will rewrite, on its own.
export const greeting = (name) => \`Hello, \${name}.\`
`,
  // The file both sides will change, arranged so the two edits *overlap*.
  //
  // This is the whole of the fixture's difficulty and it took a measurement to get right. The
  // first version of this file put your edit and the agent's three lines apart, `git merge-file`
  // applied both hunks independently, and the demo reported a clean merge -- which it was. The
  // agent's script then rewrote the line your edit sat next to and the merge *dropped the line
  // you added*, silently, which is the failure mode this whole tool exists to prevent. Adjacent
  // edits with no unchanged line between them are one hunk, and one hunk is a conflict.
  "notes.txt": `What this is: a demo project.
Second line: you will rewrite this.
Third line: untouched.
`,
  "test/app.test.js": `import test from "node:test"
import assert from "node:assert/strict"
import { greeting } from "../app.js"

test("greets by name", () => assert.match(greeting("world"), /world/))
`,
}

/**
 * What "you" changed, on the host, while the agent was not looking.
 *
 * Uncommitted on purpose: that is the state moat has to survive, and it is why the baseline is
 * a copy recorded at boot rather than the host's HEAD.
 */
const YOUR_EDIT = `What this is: a demo project.
Second line: you rewrote this, and the agent is about to change it too.
Third line: untouched.
`

/** Run `git` in the demo project, failing loudly. A demo that half-sets-up is worse than none. */
function git(cwd: string, args: string[]): { code: number; stdout: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (result.status !== 0 && !args.includes("--allow-failure")) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`)
  }
  return { code: result.status ?? 1, stdout: result.stdout ?? "" }
}


/** A port nothing is listening on, so the demo does not collide with a running stub. */
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

/**
 * Say what a cold cache is about to download, before it does it.
 *
 * A first run pulls a ~250 MB Alpine rootfs and the pinned Codex binary. Saying so up front is
 * the difference between "this is doing something" and "this is hanging", and the demo is the
 * one command a person runs before they trust the tool with a repository.
 */
function coldCacheNotice(): string[] {
  const home = process.env.MOAT_HOME || path.join(os.homedir(), ".moat")
  const cache = path.join(home, "cache")
  // Directories that hold something, named as the cache actually lays them out. The check used to
  // look for a `net` directory and require it to be non-empty, but `slirpCachePath()` is a *file*
  // (`net/slirp4netns-<version>`), so that test could never pass and every run — warm or cold —
  // announced a download it was not going to do. The demo boots with open egress and does not use
  // slirp at all, which is the second reason it does not belong in this list.
  const filled = (name: string): boolean => {
    try {
      return fs.readdirSync(path.join(cache, name)).length > 0
    } catch {
      return false
    }
  }
  const missing: string[] = []
  if (!filled("images")) missing.push("the Alpine rootfs image (~250 MB, plus the packages the image bakes in)")
  if (!filled("codex")) missing.push("the pinned Codex runtime (~140 MB tarball, verified against its digest in lib/pins.ts)")
  return missing
}

/**
 * Start the keyless model stub.
 *
 * The demo drives the real runtime against a scripted model, because a demo that needs an API
 * key is a demo nobody runs. What the script says the agent did is in
 * `stub/scripts/responses-demo.json`, next to the fixture this file writes, so the claim and the
 * scenario can be read together. Both the model stub and this script live in `stub/` rather than
 * under `test/`, because `moat demo` ships: a published package that reached into `test/` for a
 * runtime asset would work in this repository and fail for everyone who installed it.
 */
async function startStub(): Promise<{ port: number; child: ChildProcess; record: string }> {
  const port = await freePort()
  const record = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "moat-demo-record-")), "requests.jsonl")
  const script = path.join(PACKAGE_ROOT, "stub", "scripts", "responses-demo.json")
  if (!fs.existsSync(script)) throw new Error(`the demo's model script is missing: ${script}`)
  const child = spawn(
    process.execPath,
    [path.join(PACKAGE_ROOT, "stub", "mock-responses.mjs"), "--port", String(port), "--script", script, "--record", record],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000)
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) {
        clearTimeout(timer)
        resolve(true)
      }
    })
    child.on("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
  if (!ready) {
    child.kill("SIGKILL")
    throw new Error("the demo's local model stub did not start")
  }
  // The stub is up, but is the endpoint it serves the one the runtime will POST to? Checking
  // here turns a 300-second reconnect loop into an immediate, accurate failure.
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(3000) })
    if (!probe.ok && probe.status !== 404) throw new Error(`HTTP ${probe.status}`)
  } catch (error) {
    child.kill("SIGKILL")
    throw new Error(`the demo's model stub is not answering on 127.0.0.1:${port}: ${(error as Error).message}`)
  }
  return { port, child, record }
}

/**
 * Build the demo project: a real git repository, a real commit, and one change of "yours".
 *
 * The commit is the baseline moat copies. Your edit is left in the working tree, uncommitted,
 * which is the ordinary state of a repository somebody is working in.
 */
function buildProject(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const file = path.join(dir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  git(dir, ["init", "-q", "-b", "main"])
  git(dir, ["config", "user.email", "you@example.com"])
  git(dir, ["config", "user.name", "You"])
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-qm", "the project as it was"])
  // Your change, after the commit: uncommitted, like anyone's work in progress.
  fs.writeFileSync(path.join(dir, "notes.txt"), YOUR_EDIT)
}

/**
 * Run the demo, and describe what happened.
 *
 * Every phase is timed, because the gate on this command is a two-minute warm budget and a
 * number nobody measured is a number that drifts.
 */
export async function runDemo(opts: DemoOptions = {}): Promise<DemoResult> {
  // The demo drives the real CLI, so it has to name it correctly in both layouts: run from a
  // checkout, this file is `cmd/demo.ts` and the CLI is `cmd/main.ts` beside it; run from the
  // published tarball, both are `.js` under `dist/cmd/`. Asking for `main.ts` from the compiled
  // build is an ENOENT that only the published artifact sees.
  const cliFromSource = path.join(HERE, "..", "cmd", "main.ts")
  const cliEntry = fs.existsSync(cliFromSource) ? cliFromSource : path.join(PACKAGE_ROOT, "dist", "cmd", "main.js")
  const steps: Step[] = []
  const timed = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    const started = Date.now()
    const value = await fn()
    steps.push({ name, ms: Date.now() - started })
    return value
  }

  const dir = opts.dir
    ? path.resolve(opts.dir)
    : fs.mkdtempSync(path.join(os.tmpdir(), "moat-demo-project-"))
  const scratch = opts.dir === undefined
  let stub: Awaited<ReturnType<typeof startStub>> | null = null
  let booted = false

  try {
    // --- what this is about to download, before it downloads it --------------------------
    const coldCache = coldCacheNotice()
    if (coldCache.length > 0) {
      log.warn(
        "this is a cold cache, so the first run downloads:\n" +
          coldCache.map((item) => `    ${item}`).join("\n") +
          "\n  they are cached under ~/.moat and reused by every later run; this one takes a few minutes. " +
          "`moat doctor` prints the state of the cache.",
      )
    }

    stub = await startStub()

    // --- the fixture ---------------------------------------------------------------------
    log.step(`building a project in ${dir}`)
    await timed("build", () => buildProject(dir))
    const digestBefore = await timed("hash before", () => hashTree(dir).digest)

    const run = (args: string[], extra: { quiet?: boolean } = {}): string => {
      const result = spawnSync(process.execPath, [cliEntry, ...args], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          // The stub needs no key, and the demo must run with nothing in the environment: this
          // variable is what a credential would be read from, and it is what gets injected.
          MOAT_MOCK_CREDENTIAL: "moat-demo-keyless",
          ...(extra.quiet ? { NO_COLOR: "1" } : {}),
        },
      })
      if (result.status !== 0) {
        throw new Error(
          `moat ${args.join(" ")} failed (exit ${result.status}):\n${stripAnsi(result.stderr || result.stdout || "")}`,
        )
      }
      return result.stdout ?? ""
    }

    // --- boot, and let the real runtime work ---------------------------------------------
    log.step("booting a real sandbox (the runtime, the tools and the filesystem are all inside it)")
    booted = true
    await timed("up", () =>
      run(
        [
          "up",
          "--quiet",
          "--no-detect",
          "--model",
          "deepseek-flash",
          "--base-url",
          `http://127.0.0.1:${stub!.port}/v1`,
          "--credential-env",
          "MOAT_MOCK_CREDENTIAL",
        ],
        { quiet: true },
      ),
    )
    log.step("the agent is working in the copy, not in your directory")
    await timed("turn", () =>
      run(["run", `Make the greeting friendlier and note who wrote the notes. Then commit.`, "--timeout", String(opts.timeoutSeconds ?? 300)], { quiet: true }),
    )

    // --- bring the work back, and let the real planner classify it ------------------------
    log.step("fetching the agent's one ref (nothing has touched your files)")
    await timed("fetch", () => run(["fetch", "--quiet"], { quiet: true }))

    const { planApply, applyPlan, describePlan, planVerdict } = await import("../sync/apply.ts")
    const paths = (
      await import("../lib/paths.ts")
    ).envPaths(dir)
    const plan = await timed("plan", () => planApply(paths))

    const classification = planVerdict(plan)
    // The promise, measured at the point it is about: the agent has worked, its work has been
    // fetched, and *your* tree is byte-identical to what it was before any of that. Comparing
    // after the apply would be comparing the wrong thing — the apply is the step where you said
    // yes, so of course the tree changes then.
    const digestUnchanged = await hashTree(dir).digest
    if (digestUnchanged !== digestBefore) {
      throw new Error(
        "the host project changed while the agent worked, which is exactly what moat promises cannot happen " +
          `(${digestBefore} -> ${digestUnchanged})`,
      )
    }
    log.info("")
    log.info(`  ${log.bold("what changed")}   digest ${digestBefore.slice(0, 16)}…  (unchanged)`)
    for (const row of classification) {
      const verdict =
        row.verdict === "conflict"
          ? log.yellow("conflict")
          : row.verdict === "both"
            ? log.cyan("both  ")
            : row.verdict === "you"
              ? log.cyan("you   ")
              : log.green("agent ")
      log.info(`    ${verdict.padEnd(18)} ${stripAnsi(row.path)}`)
      if (row.detail) log.info(`      ${log.dim(stripAnsi(row.detail))}`)
    }
    // Be exact about the one category that is not in the list. "A file only you changed is
    // absent" is true; calling an absent file "yours" above would be inventing a row the planner
    // never produced, and this demo prints what the planner decided and nothing else.
    log.info("")
    log.info(
      `  ${log.dim("and the files only you changed: not in this list at all, because the agent did not")}`,
    )
    log.info(`  ${log.dim("touch them and there is nothing to decide. moat only reports what it has to merge.")}`)

    // --- apply, through the same path `moat apply` uses ----------------------------------
    log.step("applying the changes you accepted (the conflict is left alone)")
    const applied = await timed("apply", () => applyPlan(paths, plan))
    const digestAfter = await timed("hash after", () => hashTree(dir).digest)

    log.info("")
    log.info(`  ${log.bold("host project")} ${dir}`)
    log.info(`  digest before any of this   ${digestBefore}`)
    log.info(`  digest after the agent      ${digestUnchanged}`)
    log.info(
      digestBefore === digestUnchanged
        ? `    ${log.green("identical: nothing reached your tree until you said so")}`
        : `    ${log.red("they differ, which should not be possible here")}`,
    )
    log.info(`  digest after you accepted   ${digestAfter}`)
    log.info(`    ${log.dim("different, and only in the files above that were not conflicts")}`)
    log.info("")
    for (const line of describePlan(plan)) log.info(`  ${stripAnsi(line)}`)
    for (const row of classification.filter((entry) => entry.verdict === "conflict")) {
      log.info(`  ${log.yellow("conflict")}  ${stripAnsi(row.path)}  ${log.dim("not written")}`)
    }
    log.info("")
    log.info(
      `  applied ${applied.applied} change(s); skipped ${applied.skipped.length}` +
        `${applied.skipped.length > 0 ? `: ${applied.skipped.map((entry) => stripAnsi(entry)).join(", ")}` : ""}`,
    )
    for (const skipped of applied.skipped) {
      log.info(`  ${log.dim(`your ${stripAnsi(skipped)} is exactly as you left it: moat does not write a file you both changed`)}`)
    }

    return {
      dir,
      steps,
      digestBefore,
      digestAfter,
      classification,
      exported: applied.skipped,
      coldCache,
    }
  } finally {
    // The stub first: the sandbox is talking to it, and a box left running against a dead stub
    // makes the *next* run's agent retry until its turn times out. That is not hypothetical --
    // it is how this took 300 seconds to fail once, with Codex reporting "Reconnecting... waiting
    // for network", which reads like a problem inside the sandbox rather than a dead process here.
    stub?.child.kill("SIGKILL")
    if (!opts.keep) {
      // `moat destroy` needs the environment's own directory, and this is the one place that
      // knows whether a boot actually happened. It used to run before `cli` was defined, so the
      // teardown never ran at all and left the environment behind.
      if (booted) {
        const result = spawnSync(process.execPath, [cliEntry, "destroy", "--yes"], { cwd: dir, encoding: "utf8", env: process.env })
        if (result.status !== 0) {
          log.warn(`could not remove the demo's sandbox environment; \`moat destroy --yes\` in ${dir} does it`)
        }
      }
      if (scratch) fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}
