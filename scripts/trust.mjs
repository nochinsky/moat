#!/usr/bin/env node
// Generate docs/TRUST.md from the committed evidence.
//
// The problem this solves is not "write a landing page" — it is that every claim on such a page is a
// number somebody typed, and typed numbers drift from the thing they describe. This repository has
// already been bitten by exactly that: `SPEC.md` promised "15 isolation assertions" while the three
// egress modes print 14, 16 and 17, and nothing kept the count honest (`test/unit/docs-claims.test.ts`
// now fails if that row states a count again).
//
// So the page is generated, and it prints **only what it can derive**:
//
//   * each suite's verdict, read out of the evidence file that suite writes;
//   * the "not verified" list, read out of docs/VERIFICATION.md — the authoritative one;
//   * the commands that reproduce both.
//
// A number it cannot derive is not printed. The unit suite is the case: it writes no evidence file,
// so the page names the command and says why it has no figure, rather than carrying a count that
// would have to be maintained by hand.
//
// `test/unit/trust-generated.test.ts` regenerates this in memory and fails if the committed page
// differs, so it cannot be hand-edited without the suite saying so.
//
// Usage: node scripts/trust.mjs [--check]     (--check exits 1 if the page is stale)

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EVIDENCE = path.join(ROOT, "test", "evidence")
const OUT = path.join(ROOT, "docs", "TRUST.md")

/** Every suite, and where its verdict lives. `evidence: null` means "this one leaves no capture". */
const SUITES = [
  {
    name: "unit tests",
    command: "npm run test:unit",
    evidence: null,
    note: "Pure logic, no sandbox — this is the suite CI enforces on every change.",
  },
  {
    name: "acceptance (Codex, keyless)",
    command: "bash test/e2e-codex.sh",
    evidence: "codex-summary.txt",
    pattern: /acceptance \(codex runtime\): .*/,
  },
  { name: "extras", command: "bash test/e2e-extras.sh", evidence: "extras.txt", pattern: /^checks passed: .*/m },
  { name: "egress", command: "bash test/e2e-egress.sh", evidence: "egress.txt", pattern: /^egress checks passed.*/m },
  { name: "provider", command: "bash test/e2e-provider.sh", evidence: "provider.txt", pattern: /^checks passed: .*/m },
  { name: "demo", command: "bash test/e2e-demo.sh", evidence: "demo.txt", pattern: /^checks passed: .*/m },
  { name: "review", command: "bash test/e2e-review.sh", evidence: "review.txt", pattern: /^checks passed: .*/m },
  {
    name: "CI entrypoint",
    command: "bash test/ci-entrypoint.test.sh",
    evidence: null,
    note: "Needs no user namespaces, so unlike the sandbox suites it runs on a hosted runner too.",
  },
]

/** The rows of `docs/VERIFICATION.md`'s "Not verified" table — the authoritative list. */
function notVerified() {
  const text = fs.readFileSync(path.join(ROOT, "docs", "VERIFICATION.md"), "utf8")
  const start = text.indexOf("## Not verified")
  if (start < 0) throw new Error("docs/VERIFICATION.md has no '## Not verified' section")
  const rest = text.slice(start)
  const end = rest.indexOf("\n## ", 3)
  const body = end < 0 ? rest : rest.slice(0, end)
  return body
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-+/.test(line) && !/^\|\s*thing\s*\|/i.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 2 && cells[0].length > 0)
}

/** One suite's verdict, read from its capture — never typed. */
function verdict(suite) {
  if (!suite.evidence) return null
  const file = path.join(EVIDENCE, suite.evidence)
  if (!fs.existsSync(file)) return null
  const match = suite.pattern.exec(fs.readFileSync(file, "utf8"))
  return match ? match[0].trim() : null
}

export function renderTrust() {
  const suites = SUITES.map((suite) => ({ ...suite, result: verdict(suite) }))
  const lines = []

  lines.push("# What moat claims, and what has actually been checked")
  lines.push("")
  lines.push(
    "> **Generated** by `node scripts/trust.mjs` from this repository's own evidence. Do not edit by",
  )
  lines.push(
    "> hand: `test/unit/trust-generated.test.ts` regenerates it and fails if the committed file",
  )
  lines.push(
    "> differs. It prints no number it cannot read out of a capture, which is why some cells say",
  )
  lines.push("> what to run rather than a figure.")
  lines.push("")
  lines.push(
    "moat runs an AI coding agent inside a disposable Linux sandbox — `unshare`, `mount` and",
  )
  lines.push(
    "`chroot`, no container runtime, no daemon — and reviews what it did hunk by hunk before any of",
  )
  lines.push(
    "it reaches your machine. The point of that shape is **autonomy without approval prompts**: the",
  )
  lines.push("blast radius is a box, and copy-out is a decision you make afterwards.")
  lines.push("")
  lines.push("## What is verified, and by what")
  lines.push("")
  lines.push("| suite | result | how to reproduce |")
  lines.push("| --- | --- | --- |")
  for (const suite of suites) {
    const result = suite.result
      ? `\`${suite.result}\``
      : suite.note
        ? suite.note
        : "_no capture is committed for this one — run it and read the output_"
    lines.push(`| ${suite.name} | ${result} | \`${suite.command}\` |`)
  }
  lines.push("")
  lines.push(
    "Every sandbox suite must be run on a host with unprivileged user namespaces, which GitHub's",
  )
  lines.push(
    "runners cannot provide — see [`CI.md`](CI.md). The captures above are committed in",
  )
  lines.push("`test/evidence/` and quoted by [`VERIFICATION.md`](VERIFICATION.md).")
  lines.push("")
  lines.push("## What is **not** verified")
  lines.push("")
  lines.push(
    "Copied from [`VERIFICATION.md`](VERIFICATION.md), which is the authority. It is longer than the",
  )
  lines.push(
    "list above on purpose: a tool that hands an agent a shell should be explicit about the edges of",
  )
  lines.push("its own evidence.")
  lines.push("")
  lines.push("| thing | why |")
  lines.push("| --- | --- |")
  for (const [thing, why] of notVerified()) lines.push(`| ${thing} | ${why} |`)
  lines.push("")
  lines.push("## The contract, and the traps")
  lines.push("")
  lines.push("* [`SPEC.md`](SPEC.md) — what each command promises, and where the sharp edges are.")
  lines.push(
    "* [`SEAM.md`](SEAM.md) / [`RUNTIMES.md`](RUNTIMES.md) — the agent-harness boundary, and what a second runtime costs.",
  )
  lines.push(
    "* [`PORTABILITY.md`](PORTABILITY.md) — what is measured about running outside Linux, and what a container backend would cost.",
  )
  lines.push("* `AGENTS.md` — the invariants and the traps, for anyone changing the code.")
  lines.push("")
  return lines.join("\n")
}

/**
 * Write or check the page — **only when this file is the program being run.**
 *
 * This ran at module top level, so *importing* the script had the side effect of rewriting
 * `docs/TRUST.md`. `test/unit/trust-generated.test.ts` imports it to call `renderTrust()`, so a
 * read-only guard was quietly a writer: on a normal serial run it rewrote the page with the same
 * bytes and nobody saw it, but when the page could not be derived — the extras suite truncates its
 * capture at its start (`: > "$EVIDENCE/extras.txt"`), so a concurrent `npm run test:unit` read an
 * empty file — the guard **wrote a wrong page**, saying extras had "no capture" while the capture
 * sat on disk. Reading a derivation must not write its result.
 */
const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  const rendered = renderTrust()
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : ""
    if (current.trim() !== rendered.trim()) {
      console.error("docs/TRUST.md is stale: run `node scripts/trust.mjs`")
      process.exit(1)
    }
    console.log("docs/TRUST.md is current")
  } else {
    fs.writeFileSync(OUT, rendered)
    console.log(`wrote ${path.relative(process.cwd(), OUT)} (${rendered.split("\n").length} lines)`)
  }
}
