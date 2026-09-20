import assert from "node:assert/strict"
import { test } from "node:test"

import { COMMAND_FLAGS, FlagError, SPEC, flag, parse } from "../../lib/flags.ts"

test("a flag the command does not read is refused, naming the flag and the command", () => {
  // The bug this exists for: 'moat verify --timeout 1' was accepted and then ignored,
  // because the flag table is shared and nothing checked that the command read it. The
  // checks runner had taken a timeout from the beginning; no caller passed one. The
  // same silence swallowed '--quiet', which every test harness passes, and made
  // 'moat up --help' boot a sandbox instead of printing help.
  assert.throws(
    () => parse(["--timeout", "5"], SPEC, "fetch"),
    (error: unknown) => {
      assert.ok(error instanceof FlagError, String(error))
      assert.match(error.message, /--timeout/)
      assert.match(error.message, /moat fetch/)
      assert.match(error.message, /refused rather than ignored/)
      return true
    },
  )
  // The commands that do read it are unaffected.
  assert.deepEqual(parse(["--timeout", "5"], SPEC, "verify").flags, { timeout: 5 })
  assert.deepEqual(parse(["--timeout", "5"], SPEC, "take").flags, { timeout: 5 })
  assert.deepEqual(parse(["--timeout", "1"], SPEC, "up").flags, { timeout: 1 })
})

test("a flag nobody knows is still an unknown flag", () => {
  assert.throws(() => parse(["--bogus"], SPEC, "up"), /unknown flag: --bogus/)
})

test("--help, --quiet and --verbose are global", () => {
  for (const command of Object.keys(COMMAND_FLAGS)) {
    assert.deepEqual(parse(["--quiet"], SPEC, command).flags, { quiet: true }, command)
    assert.deepEqual(parse(["--verbose"], SPEC, command).flags, { verbose: true }, command)
    assert.deepEqual(parse(["--help"], SPEC, command).flags, { help: true }, command)
  }
})

test("everything after -- is a positional, never a flag", () => {
  const parsed = parse(["--", "--quiet", "-x", "--timeout"], SPEC, "exec")
  assert.deepEqual(parsed.flags, {})
  assert.deepEqual(parsed._, ["--quiet", "-x", "--timeout"])
})

test("numbers are numbers, booleans take =false, and a value is required", () => {
  const parsed = parse(["--timeout", "600", "--yes=false", "--model", "m", "--profile=node"], SPEC, "up")
  assert.deepEqual(parsed.flags, { timeout: 600, yes: false, model: "m", profile: "node" })
  assert.throws(() => parse(["--model"], SPEC, "up"), /flag --model needs a value/)
})

test("the command table only names flags that exist", () => {
  // A typo in the table would make a command refuse a flag it means to accept: loud at
  // the CLI, but only after someone runs that command. This catches it here instead.
  const unknown: string[] = []
  const duplicated: string[] = []
  for (const [command, flags] of Object.entries(COMMAND_FLAGS)) {
    for (const key of flags) {
      if (!Object.prototype.hasOwnProperty.call(SPEC, key)) unknown.push(command + ":--" + key)
    }
    if (new Set(flags).size !== flags.length) duplicated.push(command)
  }
  assert.deepEqual(unknown, [])
  assert.deepEqual(duplicated, [])
})

test("the flags the test suites pass to up stay declared", () => {
  // The suites boot with --quiet, --no-detect, --profile, --model, --base-url and
  // friends; a missing entry here would refuse them and the whole battery would fail,
  // but this says which flag went missing instead of a wall of boot output.
  // --quiet/--verbose/--help are global and covered by the test above.
  const used = [
    "no-detect", "profile", "model", "base-url", "credential-env", "credential-ttl",
    "credential", "no-credential", "json", "timeout", "upstream",
    "no-follow", "fresh", "sync", "yes", "force", "egress",
    "egress-allow", "show-output", "refresh",
  ]
  const missing = used.filter((key) => !COMMAND_FLAGS.up!.includes(key))
  assert.deepEqual(missing, [])
  // Every command in the table is a command moat has, and there is no attach/env/tools left:
  // those were the opencode server's surfaces.
  for (const command of ["attach", "env", "tools"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(COMMAND_FLAGS, command), false, command)
  }
})

test("flag() reads what parse() parsed", () => {
  const parsed = parse(["--tail", "5"], SPEC, "logs")
  assert.equal(flag<number>(parsed, "tail"), 5)
  assert.equal(flag(parsed, "json"), undefined)
})
