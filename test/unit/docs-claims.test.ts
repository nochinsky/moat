import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"

/**
 * SPEC is the contract, so a drifted claim in it is a defect — and one did drift:
 * the `moat doctor` row promised "15 isolation assertions" while the three egress
 * modes print 14 (`open`), 16 (`isolated`) and 17 (`filtered`), and the command
 * prints its own count. Nothing kept the number honest.
 *
 * This guard is deliberately narrow: the shape of that one row, not the prose around
 * it. A count the tool prints belongs in the capture (docs/VERIFICATION.md §4b) and in
 * the command's own output, not in a hand-maintained table.
 */
test("the commands table does not promise a doctor check count", () => {
  const spec = fs.readFileSync(new URL("../../docs/SPEC.md", import.meta.url), "utf8")
  const row = spec.split("\n").find((line) => line.startsWith("| `moat doctor`"))
  assert.ok(row, "SPEC §2.4 has a `moat doctor` row")
  assert.doesNotMatch(row, /\b\d+\s+(isolation\s+)?(assertions?|checks?)\b/i)
  // Removing the number must not be a way to say nothing: the row has to name what
  // the count depends on.
  for (const mode of ["open", "isolated", "filtered"]) {
    assert.match(row, new RegExp("`" + mode + "`"), `the row names the ${mode} mode`)
  }
  assert.match(row, /prints the count/)
})
