import assert from "node:assert/strict"
import { test } from "node:test"

import { renderInstructions, type InstructionsInput } from "../../bundle/instructions.ts"

function brief(egress: InstructionsInput["egress"]): string {
  return renderInstructions({
    provider: "DeepSeek",
    model: "deepseek/deepseek-flash",
    branch: "moat-session-test",
    profiles: [],
    installedPackages: [],
    hasCredential: true,
    canAsk: false,
    egress,
    checks: [],
    workspace: "/work",
  })
}

test("the brief tells the agent what the box can actually reach", () => {
  // The brief is the only thing that tells the agent about the network, and an
  // agent told "unrestricted" retries a dropped download instead of reporting
  // the allowlist. It shipped saying exactly that under a filtered default.
  const filtered = brief("filtered")
  assert.match(filtered, /narrowed to an allowlist/)
  assert.match(filtered, /DNS snapshot/)
  assert.doesNotMatch(filtered, /unrestricted/)
  assert.doesNotMatch(filtered, /shares the host's network position/)

  const isolated = brief("isolated")
  assert.match(isolated, /unrestricted outbound access/)
  assert.doesNotMatch(isolated, /shares the host's network position/)

  const open = brief("open")
  assert.match(open, /You have the network\*\*, unrestricted/)
  assert.match(open, /shares the host's network position/)
  assert.doesNotMatch(open, /allowlist/)
})
