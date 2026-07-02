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

**Practical takeaway:** the worker/compression role doesn't need an uncensored model — it's summarizing
existing text, not generating new creative/explicit content — so there's no guardrails-philosophy
reason to use a "Heretic" variant there. Prefer a standard instruct model with a strong tool-calling
reputation for worker tasks (e.g., NousResearch's Hermes line is specifically tuned for function-calling
as a first-class feature). The "guardrail via model selection" concern from loremaster.md applies to
the Author/Editor roles generating story content, not the Worker.

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

## Concurrency stream — `GET /v1/account/concurrency` (SSE or single-poll)

Not yet integrated. Reports real-time `limit`, `used_cost`, `request_count`, and a `requests[]` array
(id, cost, model, started_at, duration_ms) for the whole account. This is authoritative ground truth
for what's actually in flight — a real upgrade over our local in-memory slot counter
(`src/queue/slots.ts`), which can drift from reality (e.g., blind to other processes using the same
key, or to Featherless's own accounting). Worth switching to before this matters in practice (multiple
concurrent users). Not urgent while it's a single local dev instance.

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

## `chat_template_kwargs`

Per-model template overrides, mainly for reasoning/"thinking" models (`enable_thinking`,
`thinking_budget`, etc.) — relevant to the doc's per-agent "Effort toggle" for reasoning mode, not
relevant to anything built so far.

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

- [ ] Read `concurrency_cost` from the models catalog instead of hardcoding `slotCost: 4` / `slotCost: 1` in `createJob` calls.
- [x] Swap `WORKER_MODEL` away from the Heretic variant to a tool-calling-reputable standard instruct model. — done, `NousResearch/Hermes-3-Llama-3.1-8B`.
- [ ] Consider replacing `src/queue/slots.ts`'s local counter with the real `/v1/account/concurrency` feed.
- [x] Ranked-choice model fallback on 400/403/404/503 — done 2026-07-01, `withModelFallback` in `src/inference/featherless.ts`, configurable per-agent via Config > Agents.
- [ ] Same-model retry-after-backoff for 500/503 (distinct from *falling back to a different model*, which is now handled) — still open.
