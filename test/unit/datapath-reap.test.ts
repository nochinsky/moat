import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cmd", "main.ts")

/**
 * Line numbers where the CLI clears the recorded slirp pid outside `forgetBox`.
 *
 * A box that dies out of band — killed, OOM, host reboot — leaves its slirp4netns
 * datapath running, and the datapath is a separate process: the only thing that can
 * attribute it is the pid and start time in state.json. A command that clears or deletes
 * that record without stopping the process leaves it running with nothing naming it, and
 * `moat destroy --all` — the documented way to reclaim what moat holds — cannot see it.
 *
 * That was not one bug but four: `up` was fixed first, and `down`, `restore` and
 * `destroy` still forgot the datapath, each in a different branch for the box that is
 * already gone or is no longer ours. Review does not catch that shape, so it is checked
 * mechanically: only `forgetBox` may clear the record, because it reaps first. The line
 * numbers come back rather than a boolean so a failure names the write.
 */
export function clearedDatapathWrites(source: string): number[] {
  const found: number[] = []
  let fn = ""
  source.split("\n").forEach((line, index) => {
    const declaration = /^(?:async )?function (\w+)/.exec(line)
    if (declaration) fn = declaration[1]!
    const trimmed = line.trim()
    // A doc comment that mentions the shape is not the shape.
    if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) return
    if (/slirpPid:\s*null/.test(line) && fn !== "forgetBox") found.push(index + 1)
  })
  return found
}

/**
 * Top-level functions that end a box without calling anything that stops the datapath.
 *
 * `clearedDatapathWrites` catches a record cleared in place, branch by branch, which is
 * how `down`, `restore` and `up` got it wrong. `destroy` never writes a state: it
 * deletes the environment, `state.json` with it, so there is no line to scan for, and
 * this coarser rule is what covers that path — a function that removes the environment, or
 * clears the recorded datapath, has to call `forgetBox`, `reapRecordedDatapath` or
 * `stopSandbox` *somewhere*.
 *
 * The limit is real and worth stating: this cannot see one branch losing its call while
 * another branch keeps one. That is why the per-branch proof for `destroy` is the
 * behavioural half in extras section AG, which was watched failing with the call removed
 * (`destroy: FAILED — datapath left=1`).
 */
export function boxEndersWithoutReap(source: string): string[] {
  const offenders: string[] = []
  let fn = ""
  let body: string[] = []
  const inspect = () => {
    if (!fn) return
    // Doc comments explain the rule; they do not have to follow it.
    const code = body
      .filter((line) => {
        const trimmed = line.trim()
        return !(trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//"))
      })
      .join("\n")
    const endsBox = /destroyEnv\(/.test(code) || /slirpPid:\s*null/.test(code)
    const reaps = /forgetBox\(|reapRecordedDatapath\(|stopSandbox\(/.test(code)
    if (endsBox && !reaps) offenders.push(fn)
  }
  for (const line of source.split("\n")) {
    const declaration = /^(?:async )?function (\w+)/.exec(line)
    if (declaration) {
      inspect()
      fn = declaration[1]!
      body = []
      continue
    }
    body.push(line)
  }
  inspect()
  return offenders
}

test("the scanner finds a direct write, so the guard below can fail", () => {
  // The control for the guard: a check that cannot fail is not a check.
  const violation = [
    "async function cmdDown(paths, state) {",
    "  writeState(paths, { ...state, status: \"stopped\", pid: null, slirpPid: null })",
    "}",
  ].join("\n")
  assert.deepEqual(clearedDatapathWrites(violation), [2])

  assert.deepEqual(
    clearedDatapathWrites(
      ["async function forgetBox(paths, state) {", "  const stopped = { slirpPid: null }", "}"].join("\n"),
    ),
    [],
    "forgetBox is the one place allowed to clear it",
  )
  assert.deepEqual(
    clearedDatapathWrites(" * a doc comment about slirpPid: null is not a write"),
    [],
    "prose is not code",
  )
})

test("only forgetBox clears a datapath record, and it reaps before it writes", () => {
  const source = fs.readFileSync(CLI, "utf8")
  const offenders = clearedDatapathWrites(source)
  assert.deepEqual(
    offenders,
    [],
    "these lines clear the recorded datapath outside forgetBox, so nothing stops the " +
      "process first; call forgetBox instead:\n" + offenders.join("\n"),
  )

  // forgetBox's own order is the behaviour: a record cleared before the reap has already
  // lost the pid the reap needs, which is how the original bug read as "nothing to do".
  const body = source.slice(source.indexOf("async function forgetBox("))
  const reap = body.indexOf("await reapRecordedDatapath(")
  const write = body.indexOf("writeState(paths, stopped)")
  assert.ok(reap !== -1 && write !== -1, "forgetBox must reap and then write")
  assert.ok(reap < write, "forgetBox reaps before it clears the record")

  // Every branch that ends a box: four endings inside `up`, three in `down`, two in
  // `restore`. The count is a floor, not a target — a new ending has to go through here.
  const calls = source.match(/await forgetBox\(/g)?.length ?? 0
  assert.ok(calls >= 9, `expected the box-ending branches to call forgetBox; found ${calls}`)
})

test("a command that ends a box calls something that reaps its datapath", () => {
  const source = fs.readFileSync(CLI, "utf8")
  assert.deepEqual(
    boxEndersWithoutReap(source),
    [],
    "these functions remove the environment or clear its datapath and never stop a " +
      "datapath anywhere; call forgetBox or reapRecordedDatapath",
  )

  // The control: destroy never writes a state, so only this rule catches it going back.
  assert.deepEqual(
    boxEndersWithoutReap(
      ["async function cmdDestroy(paths, state) {", "  destroyEnv(paths)", "}"].join("\n"),
    ),
    ["cmdDestroy"],
  )
  assert.deepEqual(
    boxEndersWithoutReap(
      [
        "async function cmdDestroy(paths, state) {",
        "  await reapRecordedDatapath(state)",
        "  destroyEnv(paths)",
        "}",
      ].join("\n"),
    ),
    [],
    "reaping is what the rule asks for",
  )
})
