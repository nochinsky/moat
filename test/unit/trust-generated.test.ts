import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * The trust page is a derivation, not a claim.
 *
 * `docs/TRUST.md` carries numbers — each suite's verdict, the list of what is *not* verified — and a
 * number somebody typed drifts from the thing it describes. This repository has been bitten by
 * exactly that: `SPEC.md` promised "15 isolation assertions" while the three egress modes print 14,
 * 16 and 17, with nothing keeping the count honest. Running the generator in `--check` mode is what
 * makes the committed page a product of the evidence rather than a promise about it, and this test
 * is what makes that true on every run.
 */
test("docs/TRUST.md is exactly what scripts/trust.mjs produces", () => {
  const out = execFileSync("node", [path.join(ROOT, "scripts", "trust.mjs"), "--check"], {
    encoding: "utf8",
    cwd: ROOT,
  })
  assert.match(out, /is current/, "the generator reports the page as current")
})

test("the generator refuses to print a figure it cannot derive", () => {
  // A suite with no committed capture must not be given a number. The unit suite is the case: it
  // leaves no evidence file, so the page names the command instead of carrying a count that would
  // have to be maintained by hand.
  const page = execFileSync("node", ["-e", "import('./scripts/trust.mjs').then(m => process.stdout.write(m.renderTrust()))"], {
    encoding: "utf8",
    cwd: ROOT,
  })
  assert.match(page, /npm run test:unit/, "the unit suite is named")
  assert.doesNotMatch(page, /npm run test:unit \| `\d+ pass/, "and is not given a number nobody derived")
  // The derived ones are there, and they came out of the captures.
  assert.match(page, /checks passed: \d+, failed: 0/)
  assert.match(page, /## What is \*\*not\*\* verified/)
})
