import assert from "node:assert/strict"
import crypto from "node:crypto"
import { test } from "node:test"

import { CATALOG_INSTRUCTIONS_SHA256, catalogAllEffortLevels, catalogEntry } from "../../bundle/codex.ts"
import { CODEX_BUILTIN_PROMPT } from "../../bundle/codex-prompt.ts"
import {
  DEFAULT_REASONING_LEVELS,
  catalogEntryForModel,
  reasoningLevelsFor,
  renderModelCatalog,
} from "../../bundle/model-catalog.ts"

/**
 * The fields the pinned 0.155.1 binary demands in a `model_catalog_json` entry.
 *
 * Discovered, not guessed: the parser names each missing field in turn and refuses the file,
 * so this set is what it asked for, in order, before it accepted one. It is asserted here
 * because a Codex bump can add to it, and a boot that writes a catalog the runtime rejects
 * fails with an error about a file the user never wrote.
 */
const REQUIRED_FIELDS = [
  "slug",
  "display_name",
  "supported_reasoning_levels",
  "shell_type",
  "visibility",
  "supported_in_api",
  "priority",
  "support_verbosity",
  "truncation_policy",
  "experimental_supported_tools",
  // Required on top of those: the binary exits 1 with neither this nor
  // `model_messages.instructions_template`.
  "base_instructions",
]

test("the catalog carries Codex's own prompt, pinned by digest", () => {
  // The schema requires `base_instructions` or `model_messages.instructions_template` (measured:
  // 0.155.1 exits 1 with neither), so the field cannot be dropped. What fills it must be the
  // pinned binary's own text, or installing a catalog would silently change what the agent is
  // told — DeepSeek's copy of that field is a different prompt.
  //
  // The prompt used to live inside a 38KB vendored JSON file. It is a source constant now, so
  // the pin is reviewable on its own, and this test is what keeps a Codex bump from moving the
  // binary's prompt while moat keeps sending the old one.
  const sha = crypto.createHash("sha256").update(CODEX_BUILTIN_PROMPT).digest("hex")
  assert.equal(sha, CATALOG_INSTRUCTIONS_SHA256)
  // Both counts, because they differ and the difference is not obvious: the prompt carries 70
  // typographic quotes, so it is 16979 UTF-16 code units and 17119 UTF-8 bytes. The digest above
  // is the binding pin (a request through the stub carries exactly these bytes — measured); these
  // two are what notices a rewrite that happens to keep the length in one unit but not the other.
  assert.equal(CODEX_BUILTIN_PROMPT.length, 16979, "the prompt's UTF-16 length, in code units")
  assert.equal(Buffer.byteLength(CODEX_BUILTIN_PROMPT, "utf8"), 17119, "the prompt's UTF-8 length, in bytes")
  // It is the binary's text, not a moat-written one: this is the opening of Codex's built-in
  // prompt, and a substitution would change it.
  assert.match(CODEX_BUILTIN_PROMPT, /^You are a coding agent running in the Codex CLI/)
  assert.ok(!/DeepSeek/i.test(CODEX_BUILTIN_PROMPT.slice(0, 400)), "not the vendor's substitute prompt")
})

test("a rendered entry has every field the pinned binary requires", () => {
  const entry = catalogEntryForModel({ model: "some-other-model" })
  for (const field of REQUIRED_FIELDS) {
    assert.ok(field in entry, `the parser requires ${field}`)
    assert.notEqual((entry as Record<string, unknown>)[field], undefined, `${field} must have a value`)
  }
  // And the file it goes into is a catalog object with that one model.
  const parsed = JSON.parse(renderModelCatalog({ model: "some-other-model" })) as { models: unknown[] }
  assert.equal(parsed.models.length, 1)
})

test("any model id renders, with its own metadata and no vendor's", () => {
  // This is the unlock: the catalog used to describe two DeepSeek models and nothing else, so a
  // boot against another provider either carried the wrong metadata or none. Nothing in the
  // rendered entry may hard-code a vendor.
  const entry = catalogEntry("llama-3.3-70b", {
    displayName: "Llama 3.3 70B",
    contextWindow: 131072,
    maxOutputTokens: 8192,
  })
  assert.equal(entry.slug, "llama-3.3-70b")
  assert.equal(entry.display_name, "Llama 3.3 70B")
  assert.equal(entry.context_window, 131072)
  assert.equal(entry.max_output_tokens, 8192)
  // The prompt is still the binary's own, whatever the model: it is a property of the runtime,
  // not of the model.
  assert.equal(entry.base_instructions, CODEX_BUILTIN_PROMPT)
  const text = renderModelCatalog({ model: "llama-3.3-70b" })
  assert.ok(!/deepseek/i.test(text), "a rendered catalog for another model must not name DeepSeek")
  // An unknown model's label falls back to its id rather than inventing a vendor name.
  assert.equal(catalogEntryForModel({ model: "mystery-model" }).display_name, "mystery-model")
})

test("a token count that is not a usable integer is left out of the catalog", () => {
  // The catalog is JSON, so a bad count cannot break the parse the way `model_context_window =
  // NaN` breaks the config. It can still declare something false, which is worse than declaring
  // nothing: Codex would compact against a context window that does not exist. The rule matches
  // the TOML renderer's.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1e999, -1, 0, 1.5, Number.MAX_VALUE]) {
    const entry = catalogEntryForModel({ model: "m", contextWindow: bad, maxOutputTokens: bad })
    assert.equal(entry.context_window, undefined, `contextWindow=${String(bad)} should be left out`)
    assert.equal(entry.max_output_tokens, undefined, `maxOutputTokens=${String(bad)} should be left out`)
    // The entry is still complete: a missing count must not cost the required fields.
    for (const field of REQUIRED_FIELDS) assert.ok(field in entry, field)
  }
  const good = catalogEntryForModel({ model: "m", contextWindow: 131072, maxOutputTokens: 32768 })
  assert.equal(good.context_window, 131072)
  assert.equal(good.max_context_window, 131072, "the two window fields agree")
  assert.equal(good.max_output_tokens, 32768)
})

test("the reasoning ladder is per model, and defaults to the one moat has always offered", () => {
  // `--effort` is validated against this list. It was hard-coded to DeepSeek's three levels
  // because the catalog only described DeepSeek; a provider with a different ladder overrides it
  // rather than being offered a level it does not implement.
  assert.deepEqual(reasoningLevelsFor(catalogEntryForModel({ model: "m" })), ["low", "high", "max"])
  assert.deepEqual(
    reasoningLevelsFor(
      catalogEntryForModel({
        model: "m",
        reasoningLevels: [
          { effort: "none", description: "no thinking" },
          { effort: "medium", description: "some" },
        ],
        defaultReasoningLevel: "medium",
      }),
    ),
    ["none", "medium"],
  )
  assert.equal(catalogEntryForModel({ model: "m", defaultReasoningLevel: "medium" }).default_reasoning_level, "medium")
  assert.equal(catalogEntryForModel({ model: "m" }).default_reasoning_level, "high")
  // The exported helper the CLI validates against follows the same path.
  assert.deepEqual(catalogAllEffortLevels(), DEFAULT_REASONING_LEVELS.map((level) => level.effort))
})

test("provider overrides reach the entry, and cannot replace the required shape", () => {
  // A provider that needs a different tool surface sets it here. The override is merged under
  // the identity fields, so it cannot rename the model out from under the caller.
  const entry = catalogEntryForModel({
    model: "real-model",
    overrides: { shell_type: "unified_exec", apply_patch_tool_type: "unified" },
  })
  assert.equal(entry.shell_type, "unified_exec")
  assert.equal(entry.apply_patch_tool_type, "unified")
  assert.equal(entry.slug, "real-model")
  assert.equal(entry.base_instructions, CODEX_BUILTIN_PROMPT)
})
