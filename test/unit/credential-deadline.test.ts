import test from "node:test"
import assert from "node:assert/strict"
import { credentialDeadline, watchCredentialExpiry } from "../../sandbox/credential-deadline.ts"
import { runInSandbox, runInteractive } from "../../sandbox/launcher.ts"
import type { EnvPaths } from "../../lib/paths.ts"

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
test("deadline is the broker's timestamp; keyless has none and malformed timestamps refuse", () => {
  assert.equal(credentialDeadline({ MOAT_CREDENTIAL_EXPIRES_EPOCH: "123" }), 123000)
  for (const value of [undefined, "", "0"]) assert.equal(credentialDeadline({ MOAT_CREDENTIAL_EXPIRES_EPOCH: value }), null)
  for (const value of ["NaN", "Infinity", "-1"]) assert.throws(() => credentialDeadline({ MOAT_CREDENTIAL_EXPIRES_EPOCH: value }), /refusing the boot/)
})
test("host expiry watcher fires once and cancellation does not leak a watchdog", async () => {
  let fired = 0
  const stop = watchCredentialExpiry(Date.now() + 20, () => fired++)
  await sleep(40); assert.equal(fired, 1); stop()
  const cancel = watchCredentialExpiry(Date.now() + 20, () => fired++)
  cancel(); await sleep(40); assert.equal(fired, 1)
  watchCredentialExpiry(null, () => fired++)(); assert.equal(fired, 1)
})
test("expired credentials refuse batch and interactive boots before touching disk or spawning", async () => {
  // Deliberately unusable: a refusal cannot write scripts, start a runtime or run the body.
  const paths = { rootfs: "/moat-no-such-rootfs" } as EnvPaths
  const opts = { env: { MOAT_CREDENTIAL_EXPIRES_EPOCH: "1" } }
  const result = await runInSandbox(paths, "exit 0", opts)
  assert.equal(result.code, 124); assert.equal(result.credentialExpired, true)
  assert.equal(result.timedOut, false); assert.match(result.output, /credential expired/)
  assert.equal(await runInteractive(paths, "exit 0", opts), 124)
})
