# Cross-model reasoning-shape probe (2026-07-17)

Triggered by a real bug report: `moonshotai/Kimi-K2.7-Code`'s reasoning was showing up inside the
visible story text. Initial theory was "Kimi's JSON shape is different from DeepSeek's" — disproven
below. The actual bug and fix are in [reasoning-stream-research.md](reasoning-stream-research.md)'s
final section; this doc is the empirical evidence that motivated it.

**Related:** [featherless-notes.md](featherless-notes.md), [reasoning-stream-research.md](reasoning-stream-research.md).

## Method

`scripts/probe-model-shapes.ts` — one plain streaming call per model, no `chat_template_kwargs`,
same prompt as the existing DeepSeek probes. Logs every delta key seen, accumulated `content` vs.
any reasoning-shaped field, and whether `<think>` tags appear inline in `content`. Real model IDs
looked up live via `listModels()` (`src/inference/featherless-models.ts`) rather than guessed —
Featherless's `model_class` field (e.g. `kimi-k25`, `deepseek4-1.6t`, `qwen3-32b`) is a real,
API-provided family signal worth revisiting if a data-driven registry ever replaces name-substring
checks (see reasoning-stream-research.md's "Future: per-model stream-shape confirmation" section).

Artifacts: `data/experiments/model-shapes/*.json` (summary), `*-raw.jsonl` (every raw SSE line).

## Result: three distinct shapes, not two

| Shape                                                                           | Models observed (no `chat_template_kwargs` sent)                   | Structurally detectable?                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| A. Separate `delta.reasoning` field + separate `delta.content` field            | DeepSeek-V4-Pro, **Kimi-K2.7-Code**, Kimi-K2-Thinking, gpt-oss-20b | Yes — field presence                                |
| B. `<think>...</think>` tags inline inside `delta.content`, no separate field   | Qwen3-8B                                                           | Yes — `ReasoningStreamSplitter` already parses this |
| C. Reasoning as fully unmarked plain text in `delta.content` — no field, no tag | GLM-4.7-Flash                                                      | **No** — structurally invisible                     |

Gemma-4-E2B-it produced clean `content`-only output with no reasoning at all (matches
featherless.ai/docs' claim that Gemma 4 defaults `enable_thinking: false`).

### Correction to the original bug theory

Kimi-K2.7-Code uses the _same_ shape as DeepSeek — a separate `reasoning` field, cleanly split from
`content` (both populated in the same response: 420 reasoning chars + 990 content chars in one
run). It is not a shape mismatch. The actual bug: `isReasoningModel()`'s `/deepseek/i` name check
gated whether reasoning-field content got routed to the trace channel, and Kimi doesn't match that
regex — so its reasoning fell through to the same code path that (for DeepSeek specifically) tries
to guess whether Effort-Off reasoning-field text is secretly a misrouted answer. Kimi's reasoning
text doesn't match the DeepSeek-specific `looksLikeLeakedReasoningArtifact` signature (`/^\s*article/i`,
see reasoning-stream-research.md), so it sailed through unfiltered into the visible reply.

### GLM-4.7-Flash — a second, separate finding

With no `chat_template_kwargs` sent at all, GLM defaults to thinking-on and streams its
meta-analysis as ordinary `content` text with zero marker:

```
1. **Analyze the Request:** * **Role:** Fantasy RPG Narrator. * **Task:** Write 2 short
in-character paragraphs. * **Constraint:** No meta commentary...
```

No amount of shape-based routing can separate this after the fact — there's nothing to detect. A
follow-up probe (`scripts/probe-kwarg-keys.ts`, not checked in — see below) confirmed
`chat_template_kwargs: { enable_thinking: false }` (the key this codebase already knows how to
send) does suppress it, producing clean prose. `thinking: false` (the key
featherless.ai/docs/chat-template-kwargs claims for DeepSeek-family models) had no effect on GLM,
confirming the kwarg key is genuinely family-specific and not interchangeable.

The same follow-up probe against Kimi-K2.7-Code found neither `enable_thinking: false` nor
`thinking: false` fully suppressed its `reasoning` field (222 and 74 chars respectively, vs. 420
with no kwargs at all) — `content` was populated alongside it either way, consistent with shape A
above (genuinely separate fields, not a misrouted answer), just not a model that fully honors
either disable toggle.

## Fix (2026-07-17, `src/inference/featherless.ts` + `src/queue/provider-dispatch.ts`)

1. **Trace routing is now shape-based, not name-based.** Any reasoning-field or `<think>`-tagged
   content is always routed to the thinking-trace channel, for any model, unconditionally.
   `looksLikeLeakedReasoningArtifact` and its peek-buffer machinery in `streamWithFallback` were
   removed — that heuristic never generalized past the one DeepSeek signature it was built from,
   which is exactly what let Kimi's reasoning through. If a candidate produces reasoning but
   `content` never arrives, that's treated as a retriable "no answer content" failure (same as an
   empty completion) rather than an attempt to promote the reasoning text into the reply — a model
   can legitimately exhaust its token budget mid-thought (confirmed live: Kimi-K2-Thinking hit a
   300-token cap while still reasoning, zero `content`), and showing raw chain-of-thought as if it
   were the story would be worse than retrying.
2. **`chat_template_kwargs.enable_thinking` now defaults to `false`** unless a caller explicitly
   sets it, in both `streamWithFallback` (covers Author prose and the Editor's guided setup
   conversation) and `completeChat` (covers worldbook-compact, story-to-date summaries, and
   scene/story naming — none of which run the reasoning/answer splitter at all, so an unmarked-leak
   model would corrupt stored data outright). This is what actually prevents the GLM-style leak,
   since it can't be detected after the fact.

`isReasoningModel()` (the `/deepseek/i` name check) is kept, but narrowed to what it can actually
be used for: the pre-response `<think>\n` assistant-prefill trick and the idle-timeout budget, both
decided before a reply exists and therefore not shape-detectable. It is deliberately no longer used
to decide trace routing.

## Follow-up fixes (2026-07-17, same day)

All three items originally scoped out were addressed on request:

1. **`resolveChatTemplateKwargs()`** (`src/inference/featherless.ts`) replaces the flat
   `{ enable_thinking: false, ...overrides }` object literal that used to be duplicated in
   `completeChat` and `streamWithFallback`. It now sends **both** `enable_thinking` and `thinking`
   set to the same value — covering Qwen/GLM/Gemma (`enable_thinking`) and DeepSeek/Kimi (`thinking`,
   per the docs table) without a per-model registry, since an unrecognized key is silently ignored
   either direction (confirmed above: GLM ignores `thinking`; this codebase already relied on
   DeepSeek honoring `enable_thinking` despite the docs saying it shouldn't). When thinking is
   explicitly on, it also sends `preserve_thinking: true` / `clear_thinking: false` per the docs'
   explicit agentic/tool-use guidance. `completeChat`, `callWithTools`, and `streamWithFallback` all
   route through this one function now.
2. **`stripThinkingTags()`** (`src/inference/reasoning-stream.ts`) strips `<think>...</think>` from
   a complete (non-streamed) reply, applied in both `completeChat` and `callWithTools` before the
   empty-completion check. An unclosed trailing tag (budget spent entirely on reasoning, confirmed
   live: Qwen3-8B did this at `max_tokens: 300`, forced `enable_thinking: true`) drops everything
   from that point, which correctly surfaces as "model returned an empty completion" rather than
   showing raw chain-of-thought — same philosophy as the streaming path's empty-content handling
   above. Verified live: Qwen3-8B forced to think, with `max_tokens: 900`, returned a clean reply
   with no `<think>` residue; GLM-4.7-Flash with no override returned clean prose (no meta-analysis).
3. **`callWithTools` now accepts `chatTemplateKwargs`** and applies the same default/stripping as
   `completeChat`. Worth flagging: **`callWithTools` currently has zero callers anywhere in this
   codebase** (confirmed via search — the `callWithForcedTool` function its own docstring compares
   itself to doesn't exist either). It appears to be a retained-but-unused remnant, possibly from
   before Worker moved to the bracket-tag convention. Wiring it up cost nothing and covers it if it's
   ever revived, but there was no live bug here to fix — worth knowing before assuming this was a
   real gap the way the other two were.
