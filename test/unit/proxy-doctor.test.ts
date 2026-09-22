import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { filteredEgressCheck, proxyProbeScript } from "../../sandbox/isolation.ts"

/**
 * The reachability row says which component dialed.
 *
 * With `--egress-proxy` the probe goes through the proxy rather than around it, because a proxied box
 * keeps no resolver and `/dev/tcp/<host>/<port>` would have to resolve the host *in the box*. A probe
 * that asked directly would therefore report a working proxy as an unreachable provider, so the wording
 * has to come from the probe that was actually run — and the ruleset's wording is the control.
 */
const probe = { host: "api.deepseek.com", port: 443 }

describe("the reachability row says which component dialed", () => {
  it("says through the proxy when the proxy decided", () => {
    const row = filteredEgressCheck({ egressOpen: false, allowedProbe: probe, allowedReachable: true, viaProxy: true })
    assert.equal(row.ok, true)
    assert.match(row.detail, /api\.deepseek\.com:443 is reachable through the proxy$/)
  })

  it("keeps the ruleset's wording when no proxy was involved", () => {
    const row = filteredEgressCheck({ egressOpen: false, allowedProbe: probe, allowedReachable: true })
    assert.equal(row.ok, true)
    assert.match(row.detail, /api\.deepseek\.com:443 is reachable$/)
  })

  it("fails, and names the proxy, when the endpoint was not reached", () => {
    const row = filteredEgressCheck({ egressOpen: false, allowedProbe: probe, allowedReachable: false, viaProxy: true })
    assert.equal(row.ok, false)
    assert.match(row.detail, /was not reachable through the proxy$/)
  })
})

/**
 * And the generated script has to be a script. It was not: the probe's two statements were joined by a
 * literal backslash-n rather than a newline, so the shell read `\ncase` as a *command name*, the `case`
 * never ran, and the variable the row reads was never emitted. The row then reported a working proxy as
 * an unreachable provider — and because the same script handed by hand to the box on one line worked,
 * the reading looked like a timing problem and was "fixed" twice for the wrong reason. This is the check
 * that would have caught it, so it is here rather than only in the prose.
 */
describe("the generated probe is a runnable script", () => {
  it("separates its statements with newlines, not with the characters \\ and n", () => {
    const script = proxyProbeScript({ host: "api.deepseek.com", port: 443 })
    // The request legitimately carries `\r\n` for printf, so the test is about *statements*: the case
    // must begin its own line rather than being glued to the assignment that precedes it.
    const lines = script.split("\n")
    assert.ok(lines.length >= 2, "the probe must contain a real newline")
    assert.ok(
      lines.some((l) => l.startsWith('case "$line" in')),
      `the case must be a statement of its own: ${JSON.stringify(script)}`,
    )
    assert.ok(!script.includes("\\ncase"), "no statement may be glued on with a literal backslash-n")
  })

  it("emits nothing when there is no endpoint to probe, rather than a broken half", () => {
    assert.equal(proxyProbeScript(undefined), "")
  })
})
