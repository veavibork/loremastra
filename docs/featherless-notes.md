# Featherless API — working notes

Featherless's published docs (https://featherless.ai/docs) don't always match live behavior. This
file tracks what we've confirmed empirically against the real API, so we don't re-discover the same
things twice. Update this whenever behavior surprises us.

## Every request needs a real `User-Agent`

Node's default `fetch` User-Agent gets silently blocked by Featherless's Cloudflare WAF — it returns
`404 Not Found` with body `Gone.` instead of an honest `403`. A custom, non-empty `User-Agent` (doesn't
need to impersonate curl/a browser) fixes it. Confirmed 2026-07-01. All requests in
`src/inference/featherless.ts` and `src/inference/featherless-models.ts` set
`FEATHERLESS_USER_AGENT` (from `src/config.ts`) for this reason.

This was specifically reproduced on `/v1/models`. Chat completions worked without it in our testing,
but we set it everywhere defensively now that we know the WAF exists.

## `GET /v1/models` — real response schema

Docs describe a flat `capabilities` array per model and don't mention `concurrency_cost`. The actual
response (confirmed 2026-07-01) looks like:

```json
{
  "id": "moonshotai/Kimi-K2-Instruct",
  "is_gated": false,
  "created": 1752500077,
  "model_class": "kimi-k2",
  "owned_by": "Feather",
  "context_length": 32768,
  "max_completion_tokens": 32768,
  "concurrency_cost": 4,
  "features": { "tool_use": true },
  "available_on_current_plan": true
}
```

- `features.tool_use` (nested boolean) is the real tool-support flag — not a top-level `capabilities` list.
- `concurrency_cost` is a real, per-model field. **We should be reading this instead of hardcoding
  slot costs** (`authorProfile`/`workerProfile` currently hardcode 4 and 1 in job creation — this
  should come from the catalog instead, see TODO below).
- `max_completion_tokens` is sometimes absent even on non-gated, available models.

### `capabilities` query param — real but imprecise

`?capabilities=chat,tool-use` does filter server-side (434 results vs ~22,265 unfiltered in one test),
but it's approximate: ~5% of what it returns doesn't actually have `features.tool_use: true`. Use it as
a server-side pre-filter to shrink the payload (the unfiltered endpoint can return tens of thousands of
models), but always verify `features.tool_use` client-side as the authoritative check. This is what
`listModels({ requireToolUse: true })` in `src/inference/featherless-models.ts` does.

### `q` param

Fuzzy search by name or ID, not an exact-match lookup. `getModel(id)` works around this by searching
then filtering to an exact `id` match client-side.

## `capabilities: tool_use: true` doesn't mean reliable forced tool-calling

Confirmed 2026-07-01: `0xA50C1A1/Mistral-Nemo-Instruct-2407-Heretic-v2` (our original worker model) is
listed with `features.tool_use: true`, but failed to call a forced tool in **0 of 14** real attempts
across two test runs (`callWithForcedTool` in `src/inference/featherless.ts`). Working theory: this is
a "Heretic" (abliterated/uncensored) fine-tune, and the ablation process that removes refusal behavior
can degrade unrelated instruction-following capabilities like structured tool use, even though the
base Mistral-Nemo architecture supports it. The catalog flag reflects architecture support, not
per-finetune reliability.

**Practical takeaway (historical):** Worker tasks no longer include per-post compression (retired
2026-07-04). Worker now handles lightweight naming (`archive-name` scene titles). Prefer instruct
models with reliable completions for Worker-tier jobs.

## Multi-tool-call turns can come back with a null `tool_calls[].id`

Confirmed 2026-07-01 during the Editor's setup conversation (`callWithTools`,
`src/inference/featherless.ts`): when `deepseek-ai/DeepSeek-V4-Pro` called four tools in a single
turn (creating an NPC and a location back-to-back), some entries in the response's `tool_calls` array
had `id: null`. Passed straight through into the next request (per the OpenAI-style protocol, each
tool result message must reference the call it answers via that id), Featherless rejected the request
outright: `422 messages.N.tool_calls.M.id: Expected string, received null`. A real id is required to
correlate results back to calls, so a missing one now gets a synthetic fallback (`call_{index}_{time}`)
generated client-side rather than forwarded as-is. Single forced-tool-call turns (`callWithForcedTool`)
were unaffected — this only showed up with multiple simultaneous tool calls in one response.

## Error codes (from docs, plus one observed live: 404)

| Code | Meaning | Guidance |
|---|---|---|
| 400 | Model cold, not loaded into GPU yet | Can take 5min–1hr to warm; retry after waiting |
| 401 | Bad/missing API key | Fatal — fix credentials, don't retry |
| 403 | Model is gated, needs unlock on Featherless's site | Retry after unlocking |
| 404 | Model id doesn't exist (`model_not_found`) — **not in Featherless's own docs**, hit live 2026-07-01 testing ranked-choice fallback with a deliberately bad model id | Same bucket as 400/403/503 — this model id is unusable, try a different one |
| 500 | Featherless-side failure | Retry with backoff |
| 503 | Insufficient model capacity (overloaded) | Retry with backoff; after 3 failures, consider a different model |

Wired into `src/inference/featherless.ts` as of 2026-07-01: `FeatherlessError` carries the HTTP
status, and `withModelFallback` treats 400/403/404/503 as "try the next model in
`AgentProfile.fallbackModels`" — everything else (401, network errors, empty replies) fails
immediately since a different model wouldn't fix those. Status-code-aware *retry/backoff* (as
opposed to model fallback) for 500/503 specifically is still open — right now a 500/503 either
succeeds on a fallback model or fails the job outright, with no same-model retry-after-wait.

## Concurrency stream — `GET /account/concurrency` (SSE or single-poll)

**Path corrected 2026-07-02** — no `/v1` prefix. The original note had it as `/v1/account/concurrency`,
which 404s; every other endpoint in this file lives under `/v1`, so that prefix was an easy
transcription slip. Re-confirmed live: reports real-time `limit`, `used_cost`, `request_count`, and a
`requests[]` array (id, cost, model, started_at, duration_ms) for the whole account. This is
authoritative ground truth for what's actually in flight — a real upgrade over our local in-memory
slot counter (`src/queue/slots.ts`), which can drift from reality (e.g., blind to other processes using
the same key, or to Featherless's own accounting). Worth switching to before this matters in practice
(multiple concurrent users). Not urgent while it's a single local dev instance.

### Aborting a stream client-side does NOT cancel it server-side

**Tested live 2026-07-02.** Started a streaming completion with a long `max_tokens`, forcibly killed
the client connection 2 seconds in (`timeout 2 curl ...`), then polled `/account/concurrency` once a
second afterward. The request stayed listed as in-flight — `duration_ms` climbing continuously — for
21+ seconds after the client had already disconnected, still consuming its `used_cost` slot the whole
time. **Featherless keeps generating (and billing the concurrency slot) for the full original
duration regardless of the client dropping the connection.** This matches what was seen manually in
KAI: stopping and retrying a generation there produced concurrency warnings consistent with the
original request still being counted server-side.

Practical implication: any client-side abort (a `fetch` `AbortController`, whether from
`armTimeout`'s idle timeout or a deliberate cancel) stops *us* from waiting on or displaying unwanted
output, and frees *our own* local slot counter (`src/queue/slots.ts`) immediately — but does **not**
free the real Featherless-side concurrency slot, which stays occupied until the original generation
finishes on its own. This is exactly the drift scenario the section above already warned about,
except now confirmed to be actively happening on every timeout/abort we already do today, not just a
theoretical future risk. Doesn't block using abort for UX/local-bookkeeping reasons (it's still
strictly better than waiting out the full generation before retrying), but reinforces that the
TODO below (switch to real `/account/concurrency` polling) is closer to "load-bearing" than
"someday," once multiple concurrent generations are common enough for the drift to cause real 503s.

## `/v1/tokenize`

**Tested live 2026-07-02 — does not match docs.** POST `{ model, text }` → `{ count, model }` only.
No `tokens` array, with or without `return_tokens: true` / `add_special_tokens: false` (both accepted
and silently ignored). There is no way to get real per-token ids out of this endpoint as it actually
behaves, only a token *count* — contradicts the (never-before-verified) note this replaces. Practical
effect: `stop_token_ids` on chat completions can't be populated from anything this API exposes; only
the string-based `stop` parameter is usable for reject-on-phrase behavior (Settings' banned
words/phrases feature, `src/services/stop-list.ts`, uses `stop` only for this reason). Revisit only if
Featherless ships a real tokenize response — don't re-attempt `stop_token_ids` without new evidence
this changed.

## `logit_bias`, `bad_words_ids`, and `logprobs` on `/v1/chat/completions` — all silent no-ops

**Tested live 2026-07-02.** These three OpenAI/HF-standard params are accepted in the request body
(no validation error, even with deliberately malformed types — a string where `logit_bias` expects
an object, a string where `bad_words_ids` expects an array of arrays) but have **zero effect** on
generation:

- `logit_bias`: sent `{"0": -100, "1": -100, ..., "49999": -100}` (every token id 0–49,999 banned at
  the maximum magnitude) at `temperature: 0`. Output was fully coherent English
  ("The sun shone brightly in the clear blue sky, warming the earth below.") — byte-for-byte
  identical whether 2,000 or 50,000 low-id tokens were banned. If this were doing anything, banning
  the 50,000 most common token ids should make normal English impossible to generate.
- `bad_words_ids`: same test (`[[0],[1],...,[49999]]`), same identical output.
- `logprobs: true, top_logprobs: 3`: requested, but the response has no `logprobs` field at all —
  silently dropped, not even an empty stub.

**Conclusion: there is no way to get real per-token generation control (ban/bias a specific token
without halting the response) through Featherless's exposed API, full stop.** This isn't a "wrong
token id" problem — the test didn't depend on knowing the right id, since banning the *entire* low
end of the vocab would break any tokenizer's ability to produce ordinary English if the param were
honored at all. Combined with `/v1/tokenize` never returning real token ids (see above) and
`logprobs` not echoing tokens either, there is no path — direct or indirect — to token-level control
via this API today. The `stop`-based banned-phrase feature (halts generation entirely on match,
`src/services/stop-list.ts`) remains the only working mechanism; true "suppress this word but keep
generating" is not achievable against Featherless as it currently behaves. Revisit only with new
evidence (e.g. Featherless changelog, or a model class observed behaving differently) — don't
re-attempt without a specific reason to think this has changed.

**If word-level suppression without halting is still wanted**, the only remaining path is running
inference through something other than Featherless's chat-completions endpoint for the specific
agent role that needs it (e.g., a local tokenizer to pre/post-process text, or a different provider
that honors `logit_bias`) — this is a scope decision, not a code fix, since it changes what
"suppress a filler word" costs to build.

**Decision 2026-07-02:** dropped the user-configurable banned-phrase feature's original motivation
(word suppression) as unachievable per the above. Kept one narrower use of the same "detect a
refusal" idea: `src/services/refusal-detection.ts` catalogs the GCG paper's `test_prefixes` refusal
list and prefix-matches it against background memory summaries where refusal detection is wired
(e.g. legacy compress path in `pipeline-runner.ts`; story-to-date worker may add this later) — summaries
feed memory silently, so a refusal masquerading as a recap needs to fail the job rather than poison
stored lore. Deliberately *not* applied to Author prose or the Editor's setup replies, which
stay untouched and visible to the user via the existing manual Stop/Retry controls — watching a
refusal play out there is itself useful signal for judging a model's prudishness.

## DeepSeek V4-Pro stream shape on Featherless (empirical, 2026-07-04)

**Do not trust OpenAI-compat field names without probing.** `scripts/probe-deepseek-raw.ts` logs every
SSE line and full JSON payload to `data/experiments/deepseek-raw/*.jsonl`. Summarize with
`scripts/summarize-raw-stream.ts`.

**With production prefill** (`assistant: "<think>\\n"`), one live run showed:

| Phase | Wall time | What arrived |
|---|---|---|
| HTTP 200 | +1961ms | headers |
| SSE comment | +1963ms | `: FEATHERLESS PROCESSING` |
| First data | +2221ms | `choices[0].delta.role` + **`delta.reasoning`** (not `reasoning_content`) |
| Reasoning stream | +2221ms → ~+10078ms | ~124 tokens in **`delta.reasoning`** chunks only |
| IC prose | +10078ms onward | **`delta.content`** chunks only |
| Stop | +20238ms | `delta.reasoning: null`, then `usage.completion_tokens_details.reasoning_tokens: 124` |

No `redacted_thinking` XML tags appear in streamed text. Reasoning and answer use **separate delta
fields**, not tag-wrapped `content`.

**Without prefill** (same script, earlier runs): model sometimes skips the reasoning phase entirely and
streams IC prose only in `delta.content` from the first chunk — behavior is not deterministic at
temperature 1.

Client parser must handle **`delta.reasoning`** and **`delta.reasoning_content`** (and ignore
`reasoning: null` on the stop chunk). `src/inference/reasoning-stream.ts` remains for tag-wrapped
`content` if a model ever emits that shape — not observed on Featherless V4-Pro to date.

## `chat_template_kwargs`

Per-model template overrides for reasoning/"thinking" models (`enable_thinking`, `thinking_budget`,
etc.) — wired to the Author **Effort** toggle (`src/services/toggle-presets.ts` →
`jobGenerationOptions` → `streamInference`). DeepSeek ids get reasoning-model handling (prefill,
extended idle timeout) even when Effort is off; `enable_thinking: true` may lengthen the visible
reasoning phase when the provider honors it.

## Deferred idea: cross-reference HuggingFace's own API for real per-model tags

Since Featherless exclusively sources from HuggingFace, HF's own model API likely exposes the actual
`tags` array per model (unlike Featherless's `/v1/models`, which accepts tag filters but never echoes
them back — see above). Idea: query Featherless for what's actually available for inference
(concurrency_cost, context_length, tool_use), then cross-reference by model ID against HuggingFace's API
to get the real per-model tag list, enabling actual post-hoc scoring of a fetched model instead of
query-time-only filtering. Reference: https://huggingface.co/spaces/huggingface/openapi (HF's OpenAPI
spec). **Deferred 2026-07-01** — not yet started. Before building: confirm HF's API/ToS allows this
volume of lookups without being a bad neighbor (rate limits, caching requirements, bulk-data alternatives
like their dataset exports).

## TODOs surfaced by this investigation

- [ ] Read `concurrency_cost` from the models catalog instead of hardcoding `slotCost: 4` / `slotCost: 1` in `createJob` calls. — partially done: `getAgentProfile().concurrencyCost` + catalog refresh on Agents fetch syncs stored rows.
- [x] Swap `WORKER_MODEL` away from the Heretic variant to a tool-calling-reputable standard instruct model. — done, `NousResearch/Hermes-3-Llama-3.1-8B`.
- [x] Replace `src/queue/slots.ts`'s local counter with the real `/account/concurrency` feed — done 2026-07-03 hybrid (`concurrency-feed.ts` + per-job reservations); fallback cap remains when feed unhealthy.
- [x] Ranked-choice model fallback on 400/403/404/503 — done 2026-07-01, `withModelFallback` in `src/inference/featherless.ts`, configurable per-agent via Config > Agents.
- [x] Same-model retry-after-backoff for 500/503 — done 2026-07-04, `withTransientRetry` in `src/inference/featherless.ts`.
