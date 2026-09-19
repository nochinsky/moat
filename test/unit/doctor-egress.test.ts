import assert from "node:assert/strict"
import { test } from "node:test"

import { filteredEgressCheck } from "../../sandbox/isolation.ts"

test("the filtered check does not claim a probe it never ran", () => {
  // Reported by `moat doctor` after a scheme-less --base-url boot: "an address
  // outside the allowlist (1.1.1.1:443) is refused, and the provider is reachable",
  // with no allowed probe in the run at all. The old detail came from
  // `allowedOk = !allowedProbe || …`, which is a claim about a measurement that
  // never happened.
  const noProbe = filteredEgressCheck({ egressOpen: false, allowedReachable: false })
  assert.equal(noProbe.ok, true, "the half that was measured still decides the result")
  assert.doesNotMatch(noProbe.detail, /is reachable/)
  assert.match(noProbe.detail, /one-sided/)
  assert.match(noProbe.detail, /1\.1\.1\.1:443\) is refused/)

  const probed = filteredEgressCheck({
    egressOpen: false,
    allowedProbe: { host: "api.deepseek.com", port: 443 },
    allowedReachable: true,
  })
  assert.deepEqual(probed, {
    ok: true,
    detail: "an address outside the allowlist (1.1.1.1:443) is refused, and api.deepseek.com:443 is reachable",
  })

  const unreachable = filteredEgressCheck({
    egressOpen: false,
    allowedProbe: { host: "api.deepseek.com", port: 443 },
    allowedReachable: false,
  })
  assert.equal(unreachable.ok, false)
  assert.match(unreachable.detail, /the allowlisted endpoint api\.deepseek\.com:443 was not reachable/)

  // The allowlist being wide open fails the check whichever probe was supplied.
  for (const allowedProbe of [undefined, { host: "api.deepseek.com", port: 443 }]) {
    const open = filteredEgressCheck({ egressOpen: true, allowedProbe, allowedReachable: true })
    assert.equal(open.ok, false)
    assert.match(open.detail, /reached 1\.1\.1\.1:443/)
  }
})
