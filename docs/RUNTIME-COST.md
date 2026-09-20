# What a turn costs on each runtime

Measured on this host, one identical task on each runtime, same provider and model
(`deepseek-flash`, native DeepSeek, off-peak), two fresh environments:

> Create a file named COST-PROBE.txt in the current working directory whose contents are
> exactly: cost probe. Do not modify any other file. Then finish.

| | prompt (miss) | prompt (cache hit) | output | reasoning | total | cost |
| --- | --- | --- | --- | --- | --- | --- |
| opencode 1.18.31 | 219 | 9088 | 35 | 21 | 9363 | $0.0000937 |
| codex 0.155.1 | 428 | 17024 | 179 | 61 | 17692 | $0.000259 |

**About 1.9× the tokens and 2.8× the money** for the same trivial task, at the published
off-peak Flash rates (`lib/pricing.ts`). The gap is mostly *output* (240 vs 56 tokens
including reasoning) and a prompt roughly twice the size: Codex carries a larger harness
prompt and its turn ran an extra verification command (`ls -la && cat`) whose output came
back into context. Cache hits are 96% of its prompt, which is why the money gap (2.8×) is
smaller than it looks and larger than the token gap.

How each number was read, so it can be re-checked:

* opencode persists sessions in the box at
  `~/.local/share/opencode/opencode.db` (SQLite). The assistant part row carries
  `{"input": 219, "output": 35, "reasoning": 21, "cache": {"read": 9088}}`, where `input`
  is the cache-*miss* count — the semantics `lib/pricing.ts` documents.
* Codex reports `turn.completed.usage` on its JSONL stream:
  `{"input_tokens": 17452, "cached_input_tokens": 17024, "output_tokens": 179,
  "reasoning_output_tokens": 61}`. **`input_tokens` includes the cached ones** (the
  Responses shape), which is not opencode's: the cache-miss count is
  `input_tokens - cached_input_tokens` = 428.

That difference was a real bug in the first integration: `parseCodexEvents` passed the raw
`input_tokens` as the miss count *and* the cached field separately, so a mostly-cached turn
was charged at the miss rate twice and the footer over-reported by about 10× ($0.0028
instead of $0.00026). `test/unit/codex-runtime.test.ts` now pins the subtraction against a
real captured stream.

The honest limits: one sample per runtime, one trivial task, one model. A file-heavy task
would narrow the ratio (both read and write the same files); a long autonomous run would
probably widen it, because Codex puts more text in context per step. What is *not* measured
here is the quality of the two loops, which is the thing a harness is actually for. This
file exists so the cost half of that trade is not a surprise: it is roughly 2–3× per turn
on small work, with DeepSeek's cache carrying most of the prompt.
