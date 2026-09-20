import assert from "node:assert/strict"
import { test } from "node:test"

import type { Parsed } from "../../lib/flags.ts"
import { CUSTOM_ENDPOINT, DEEPSEEK } from "../../lib/provider.ts"
import { resolveProvider } from "../../lib/resolve-provider.ts"

const parsed = (flags: Record<string, string> = {}): Parsed => ({ _: [], flags })

test("an environment created against a custom endpoint keeps it on the next boot", () => {
  // The bug: the endpoint was read only from the current argv, so the next boot — or any
  // codex run, which reboots the box — re-resolved to DeepSeek's own URL, re-rendered the
  // config and overwrote state.providerBaseUrl. A local-endpoint environment quietly became
  // a DeepSeek one. Found while pointing Codex at a local recording proxy.
  const state = {
    provider: CUSTOM_ENDPOINT.opencodeID,
    providerBaseUrl: "http://127.0.0.1:5598/v1",
    model: `${CUSTOM_ENDPOINT.opencodeID}/llama3`,
  }
  const provider = resolveProvider(parsed(), state)
  assert.equal(provider.baseUrl, "http://127.0.0.1:5598/v1")
  assert.equal(provider.opencodeID, CUSTOM_ENDPOINT.opencodeID)
  assert.equal(provider.native, false)
  assert.equal(provider.modelID, "llama3", "the environment's model is kept too")
})

test("--base-url overrides what the environment recorded", () => {
  const state = { provider: CUSTOM_ENDPOINT.opencodeID, providerBaseUrl: "http://old/v1", model: "moat/old" }
  const provider = resolveProvider(parsed({ "base-url": "http://new:1234/v1/" }), state)
  assert.equal(provider.baseUrl, "http://new:1234/v1", "trailing slashes are trimmed")
  assert.equal(provider.native, false)
  assert.equal(provider.modelID, "old")
})

test("a native environment stays native and keeps its model", () => {
  const state = {
    provider: DEEPSEEK.opencodeID,
    providerBaseUrl: DEEPSEEK.baseUrl,
    model: `${DEEPSEEK.opencodeID}/deepseek-v4-pro`,
  }
  const plain = resolveProvider(parsed(), state)
  assert.equal(plain.native, true)
  assert.equal(plain.baseUrl, DEEPSEEK.baseUrl)
  assert.equal(plain.modelID, "deepseek-v4-pro")
  const moved = resolveProvider(parsed({ upstream: "https://gateway.example/v1/" }), state)
  assert.equal(moved.native, true, "--upstream keeps the provider")
  assert.equal(moved.baseUrl, "https://gateway.example/v1")
  assert.equal(moved.upstream, "https://gateway.example/v1")
})

test("no state and no flags is DeepSeek and its default model", () => {
  const provider = resolveProvider(parsed())
  assert.equal(provider.opencodeID, DEEPSEEK.opencodeID)
  assert.equal(provider.modelID, DEEPSEEK.defaultModel)
  assert.equal(provider.native, true)
})

test("--base-url with --upstream is refused rather than silently ranked", () => {
  assert.throws(
    () => resolveProvider(parsed({ "base-url": "http://x/v1", upstream: "http://y/v1" })),
    /--base-url and --upstream are different things/,
  )
})
