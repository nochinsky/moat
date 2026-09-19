import assert from "node:assert/strict"
import { test } from "node:test"

import { driveSession, type Client } from "../../cmd/client.ts"

type StreamMode = "dies-mid-turn" | "ends-mid-turn" | "goes-idle" | "subscribe-fails"

/** A fake SDK client: records what was called, and can fail the event stream. */
function fakeClient(mode: StreamMode) {
  const calls: {
    subscribed: number
    promptAsync: number
    prompt: number
    messages: number
    abort: number
    subscribeOptions: Record<string, unknown> | null
  } = { subscribed: 0, promptAsync: 0, prompt: 0, messages: 0, abort: 0, subscribeOptions: null }
  const delta = {
    type: "message.updated",
    properties: { info: { id: "m1", role: "assistant", sessionID: "s1" } },
  }
  const text = { type: "message.part.delta", properties: { messageID: "m1", partID: "p1", delta: "hello" } }
  const part = { type: "message.part.updated", properties: { part: { id: "p1", type: "text" } } }

  async function* stream(): AsyncGenerator<unknown> {
    yield delta
    yield part
    yield text
    if (mode === "dies-mid-turn") throw new Error("socket hang up")
    // A clean end with no `session.idle`: the SDK reaches this by giving up on
    // a broken connection (one attempt, no reconnect), not by reaching the end
    // of a turn.
    if (mode === "ends-mid-turn") return
    yield { type: "session.idle", properties: { sessionID: "s1" } }
  }

  const client = {
    event: {
      subscribe: async (options: Record<string, unknown>) => {
        calls.subscribed += 1
        calls.subscribeOptions = options
        if (mode === "subscribe-fails") throw new Error("connect ECONNREFUSED")
        return { stream: stream() }
      },
    },
    session: {
      create: async () => ({ data: { id: "s1" } }),
      promptAsync: async () => {
        calls.promptAsync += 1
        return { data: {} }
      },
      prompt: async () => {
        calls.prompt += 1
        return { data: {} }
      },
      messages: async () => {
        calls.messages += 1
        return {
          data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }] }],
        }
      },
      abort: async () => {
        calls.abort += 1
        return { data: {} }
      },
    },
  }
  return { client: client as unknown as Client, calls }
}

const input = { sessionID: "s1", prompt: "hi", providerID: "moat", modelID: "m", onQuestion: async () => {} }

test("a stream that dies mid-turn does not send the prompt a second time", async () => {
  // The bug: driveSession's fallback re-sent the whole prompt through
  // session.prompt after the stream failed, even though promptAsync had already
  // put that turn in flight. A real model then sees its instruction twice (and the
  // tokens are spent twice); a settled turn can even restart.
  const { client, calls } = fakeClient("dies-mid-turn")
  const result = await driveSession(client, input)
  assert.equal(calls.promptAsync, 1)
  assert.equal(calls.prompt, 0, "the fallback must not re-send a prompt that is already in flight")
  assert.equal(calls.messages, 1, "the result must come from the transcript")
  assert.match(result.text, /hello/)
  assert.ok(
    result.errors.some((line) => /stream failed mid-turn/.test(line)),
    `the stream failure must be reported, got: ${JSON.stringify(result.errors)}`,
  )
  // The SDK's SSE client retries forever by default, so a dead connection never
  // ends the stream and this loop waits for an idle that cannot arrive. One
  // attempt is what turns a broken connection into an observable end.
  assert.equal(calls.subscribeOptions?.sseMaxRetryAttempts, 1)
  assert.equal(typeof calls.subscribeOptions?.onSseError, "function")
})

test("a stream that ends mid-turn is not reported as a finished turn", async () => {
  // What the SDK actually does when it gives up: the generator completes
  // instead of throwing. Nothing arrives afterwards, so `session.idle` never
  // comes, and before this the partial transcript was returned as a success --
  // `moat run` then exited 0 on a turn that had not finished.
  const { client, calls } = fakeClient("ends-mid-turn")
  const result = await driveSession(client, input)
  assert.equal(calls.promptAsync, 1)
  assert.equal(calls.prompt, 0)
  assert.ok(
    result.errors.some((line) => /stream ended mid-turn/.test(line)),
    `an unfinished turn must not pass as a finished one, got: ${JSON.stringify(result.errors)}`,
  )
})

test("a subscribe failure falls back to the blocking call, exactly once", async () => {
  // Before the prompt is sent there is nothing to duplicate, so the blocking path
  // is a real fallback there.
  const { client, calls } = fakeClient("subscribe-fails")
  const result = await driveSession(client, input)
  assert.equal(calls.subscribed, 1)
  assert.equal(calls.promptAsync, 0)
  assert.equal(calls.prompt, 1)
  assert.match(result.text, /hello/)
})

test("a normal stream ends the turn on session.idle without a blocking call", async () => {
  const { client, calls } = fakeClient("goes-idle")
  const result = await driveSession(client, input)
  assert.equal(calls.promptAsync, 1)
  assert.equal(calls.prompt, 0)
  assert.deepEqual(result.errors, [])
})
