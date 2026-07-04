# Reasoning / thinking stream research (2026-07-04)

Empirical notes from probing Featherless `deepseek-ai/DeepSeek-V4-Pro` — do not assume OpenAI-compat
field names or SillyTavern/KAI behavior without re-probing on the actual provider.

**Related:** [featherless-notes.md](featherless-notes.md) (API quirks), [development.md](development.md)
(milestone history).

## Probe scripts

| Script | Purpose |
|--------|---------|
| `scripts/probe-deepseek-raw.ts` | Raw SSE dump — every delta key, no assumptions |
| `scripts/summarize-raw-stream.ts` | Neutral stats on a raw jsonl file |
| `scripts/probe-thinking-kwargs.ts` | Matrix of `enable_thinking` / `thinking_budget` / prefill (simple prompt) |
| `scripts/probe-thinking-production.ts` | Same matrix on a **production-scale** Author prompt (~18.7k tokens) |

Production prompt source: latest `streamInference` entry in VM `data/outbound-requests.log`, or
`assembleAuthorPrompt()` for story `019f25e0-…` (falls back if local DB incomplete).

Artifacts: `data/experiments/thinking-kwargs/*.json`, `data/experiments/deepseek-raw/*.jsonl`.

## Featherless V4-Pro stream shape (confirmed)

With **thinking enabled + prefill** (`<think>\n`):

1. SSE comment `: FEATHERLESS PROCESSING`
2. **`delta.reasoning`** chunks (meta planning or prose-like drafts — non-deterministic at temp 1)
3. **`delta.content`** chunks (IC prose)
4. Stop: `delta.reasoning: null`; `usage.completion_tokens_details.reasoning_tokens` counts toward
   shared `max_tokens` budget

Not observed on Featherless V4-Pro: XML `<think>` tags in streamed text;
`reasoning_content` is always null (use **`delta.reasoning`**).

## `chat_template_kwargs` matrix (simple prompt, max_tokens=500)

| Prefill | enable_thinking | thinking_budget | Reasoning channel | Content | We retry? |
|---------|-----------------|-----------------|-------------------|---------|-----------|
| ✓ | *(none)* | — | meta (~378c) | IC | No |
| ✓ | **false** | — | **IC prose only** | **0** | **Yes** ← bug |
| ✗ | false | — | 0 | IC | No |
| ✓ | — | 100 | 0 | IC | No |
| ✓ | true | 100 | 0 | IC | No |
| ✓ | false | 100 | 0 | IC | No |

## Production prompt results (2026-07-04, ~18.7k prompt tokens)

| Case | Result |
|------|--------|
| **enable_thinking: false + prefill** | **RETRY** — 1000 chars IC in `delta.reasoning` only |
| **thinking_budget: 100** | Wall timeout (300s) on prod prompt — hung (works on simple prompt) |
| **baseline prefill** | OK — reasoning (2072c, mixed meta/prose) → content (1086c) |
| **enable_thinking: true ×3** | All OK — meta or mixed reasoning → content; non-deterministic style |

**Hermes-3-8B (worker):** never emits `delta.reasoning`; `enable_thinking` is a no-op for stream
shape. Forced prefill causes chat-template token leak into IC — do not prefill non-reasoning models.

## Fixes shipped (2026-07-04)

1. **Retry trace reset** (`publishStreamReset`) — internal retries no longer stack reasoning drafts in
   the UI (`21d33d7`).
2. **Effort-aware prose stream** (`proseStreamUsesReasoningTrace`, `shouldPrefillReasoning` in
   `featherless.ts`; wired in `pipeline-runner.ts`):
   - **Effort Off** (`enable_thinking: false`): no prefill; `delta.reasoning` → prose bubble (not
     trace); 90s idle timeout; no false “reasoning but no answer content” retry.
   - **Effort On / default** on DeepSeek: prefill + reasoning trace; reasoning-only completion still
     retries (model sometimes never opens `delta.content` before budget exhaustion).
3. **Parser:** forward `delta.reasoning` and `delta.reasoning_content` to SSE `thinking` events.

## Future: per-model stream-shape confirmation

**Problem:** `isReasoningModel()` is currently a substring check on model id (`/deepseek/i`). New
models or providers need empirical confirmation before we prefill, show traces, or apply retry rules.

**Planned workflow (not built yet):**

1. **Catalog lookup** — given a HuggingFace model id, fetch card metadata (tags, architecture hints).
   Starter: `scripts/sync-hf-model-tags.ts` → `src/data/hf-model-tags.json` (offline cache, no runtime
   HF calls).
2. **Provider probe** — given `(model_id, provider)` (Featherless, Horde, …), run a minimal streaming
   completion with the same knobs production uses (prefill on/off, `chat_template_kwargs`), record
   which delta keys appear (`reasoning`, `reasoning_content`, `content`), and whether thinking-only
   completions occur.
3. **Register behavior** — store probe result per `(provider, model_id)` so `proseStreamUsesReasoningTrace`
   and parsers can be data-driven instead of hardcoded.

Until that exists, run `probe-thinking-kwargs.ts` / `probe-thinking-production.ts` manually when
adding a new Author model or switching providers.

## Open questions

- **`thinking_budget: 100`** suppresses reasoning on simple prompts but ** hung** on production prompt
  (300s, no tokens) — treat as experimental; do not expose as default Effort preset until understood.
- **Non-determinism at temp 1:** same config can skip reasoning entirely or emit long prose-like
  reasoning drafts; retry stacking made this look like “five full IC variations” before trace reset.
- **Context limit:** full `assembleAuthorPrompt()` can exceed Featherless 32k on long stories; production
  outbound log captures what actually fit at send time.
