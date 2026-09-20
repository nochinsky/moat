import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { computeCost, isPeak, rateLabel, summariseTurn, usageOf } from "../../lib/pricing.ts"

// Monday 2026-09-21: 02:00 UTC is inside a peak window, 12:00 UTC is not.
const PEAK = new Date("2026-09-21T02:00:00Z")
const OFF = new Date("2026-09-21T12:00:00Z")

test("the peak window is the published UTC schedule, weekdays only", () => {
  assert.equal(isPeak(new Date("2026-09-21T00:59:00Z")), false)
  assert.equal(isPeak(new Date("2026-09-21T01:00:00Z")), true)
  assert.equal(isPeak(new Date("2026-09-21T04:00:00Z")), false)
  assert.equal(isPeak(new Date("2026-09-21T06:00:00Z")), true)
  assert.equal(isPeak(new Date("2026-09-21T10:00:00Z")), false)
  assert.equal(isPeak(PEAK), true)
  assert.equal(isPeak(OFF), false)
  assert.equal(isPeak(new Date("2026-09-19T02:00:00Z")), false, "Saturday")
  assert.equal(isPeak(new Date("2026-09-20T12:00:00Z")), false, "Sunday")
})

test("a turn that crosses the peak boundary is named mixed, not one side of it", () => {
  // The regression: the footer took its rate word from the clock at print time while the
  // money came from each request own time, so a turn running 00:59 -> 01:01 was named
  // entirely by whichever side it finished on. Both now come from one pass.
  const million = { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0 } }
  const totals = summariseTurn("deepseek-v4-pro", [
    { tokens: million, at: new Date("2026-09-21T00:59:00Z").getTime() },
    { tokens: million, at: new Date("2026-09-21T01:01:00Z").getTime() },
  ])
  assert.equal(totals.rate, "mixed")
  assert.equal(totals.requests, 2)
  assert.equal(totals.costKnown, true)
  // 0.66 off-peak + 1.32 peak per million: the requests really were billed differently.
  assert.ok(Math.abs(totals.usd - 1.98) < 1e-9, "expected 1.98, got " + totals.usd)
  // A label from one clock cannot see that, which is what the old code did.
  assert.equal(rateLabel([isPeak(new Date("2026-09-21T01:01:00Z"))]), "peak")
})

test("one-sided turns keep their own label, and an empty turn describes the rate now", () => {
  const usage = { input: 1000, output: 10, reasoning: 5, cache: { read: 2000 } }
  assert.equal(summariseTurn("deepseek-v4-pro", [{ tokens: usage, at: OFF.getTime() }]).rate, "off-peak")
  assert.equal(summariseTurn("deepseek-v4-pro", [{ tokens: usage, at: PEAK.getTime() }]).rate, "peak")
  const empty = summariseTurn("deepseek-v4-pro", [])
  assert.equal(empty.costKnown, false, "no requests is not a cost of zero")
  assert.equal(empty.requests, 0)
  assert.equal(rateLabel([], PEAK), "peak")
  assert.equal(rateLabel([], OFF), "off-peak")
})

test("reasoning is billed at the output rate and cache reads at the cache rate", () => {
  const usage = { input: 6504, output: 47, reasoning: 53, cache: { read: 2304 } }
  const cost = computeCost("deepseek-v4-pro", usageOf(usage), OFF)
  const expected = (6504 * 0.66 + 2304 * 0.022 + (47 + 53) * 1.98) / 1e6
  assert.ok(Math.abs(cost.usd - expected) < 1e-12, "expected " + expected + ", got " + cost.usd)
  assert.equal(cost.known, true)
  assert.equal(cost.peak, false)
  // An off-peak request is exactly half a peak one for the same usage.
  const peakCost = computeCost("deepseek-v4-pro", usageOf(usage), PEAK)
  assert.ok(Math.abs(peakCost.usd - cost.usd * 2) < 1e-12)
  // An unknown model is unknown, not free.
  const unknown = computeCost("no-such-model", usageOf(usage), OFF)
  assert.equal(unknown.known, false)
  assert.equal(unknown.usd, 0)
})

test("the footer rate word comes from the turn, not from the clock at print time", () => {
  // The wiring half: cmd/repl.ts must not decide the rate itself. It did
  // (peak: describeRate() === "peak"), which is the bug the tests above pin.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const source = fs.readFileSync(path.join(here, "..", "..", "cmd", "repl.ts"), "utf8")
  const offenders = source
    .split("\n")
    .flatMap((line, index) => (/describeRate/.test(line) ? [index + 1] : []))
  assert.deepEqual(offenders, [], "the rate label is summariseTurn's answer, not the REPL's")
})
