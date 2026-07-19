# Model format probe — design plan

_Drafted 2026-07-19. Status: agreed in discussion, not yet built._

## Problem

LLM input/output formatting is inconsistent per model and changes without warning when
Featherless redeploys. Mismatches produce garbage: reasoning in the response, response in
reasoning, template-token leakage. Today the defenses are shape-based runtime routing
(commit 3138d53) plus hand-run probe scripts; there is no per-model record of what a model
actually does, and no way for the app to know a model's toggles are lies.

## Framing (agreed)

**Probe = the map. Shape-based runtime routing = the safety net. Tripwire = staleness
detection.** A probe cannot "100% resolve" formats, for three empirically confirmed reasons:

1. **Shape C is undetectable when thinking is on.** GLM-4.7-Flash streams reasoning as
   unmarked plain `content` (model-shape-probe-2026-07-17.md). The only lever is kwarg
   suppression — and some models partially ignore it (Kimi-K2.7-Code, confirmed 7/17).
2. **Featherless redeploys silently.** Any cached profile can go stale at any time.
3. **Nondeterminism.** Single-run probes lie; every finding needs n≥2 plus a control
   (src/inference/schema/README.md gotchas — learned the hard way).

Goal restated honestly: eliminate hand-curation of provider/model templates, make garbage
rare and self-diagnosing.

## Prior art already in this repo

- `src/inference/schema/` — the raw-API verification test kit (deterministic curl fixtures +
  SSE parser). The manual version of this feature.
- `scripts/probe-model-shapes.ts`, `scripts/probe-thinking-kwargs.ts`,
  `scripts/probe-deepseek-*.ts`, `scripts/probe-thinking-production.ts` — ad-hoc probes whose
  findings drove the 7/17 fixes. The probe engine (step 3) productizes these.
- `docs/providers/model-shape-probe-2026-07-17.md` — the three-shapes taxonomy (A: separate
  `reasoning` field; B: inline `<think>` tags; C: unmarked plain text).
- `docs/providers/reasoning-stream-research.md` §"Future: per-model stream-shape
  confirmation" — sketched exactly this workflow; this plan supersedes that section.
- `scripts/sync-hf-model-tags.ts` → HF model-card metadata (offline cache; starter for the
  catalog-lookup half).

## Sources for the hypothesis corpus (trust-but-verify)

SillyTavern/KoboldAI instruct presets and the LLM Settings Guide HF space are **read as
hypothesis lists, never applied as config**. We use `/chat/completions` (server-side
templates), so importing their templates would re-introduce the hand-curation this feature
kills. What we mine from them:

- **Thinking-tag variants** beyond `<think>` (family-specific open/close markers) — candidate
  list for the probe and, once confirmed, data for `ReasoningStreamSplitter`.
- **Stop/EOS token catalog** per family (`<|im_end|>`, `<|eot_id|>`, `</s>`, …) — leak
  detection (Hermes-3-8B leaked `<|im_end|>` in the 7/19 audit A/B).
- **Model-name→family activation regexes** — cross-check against Featherless's
  `model_class`; where they disagree, the probe result is the tiebreaker.

Rule: presets seed the _questions_ the probe asks; only probe observations become stored
truth.

## Build order

Each step is roughly one session and leaves the app working.

### 1. Length toggle re-enable (independent, ships first)

Re-enable the composer length toggle (`web/src/components/StoryToggles.tsx` — wiring is
commented out in `generationOptionsFull`) and honor `options.responseLimit` in
`applyGenerationOptions` (`src/queue/executors/prose.ts`), overriding
`profile.responseLimit` → `max_tokens`.

**"0" semantics (agreed 2026-07-19):** a `0` step means "no fixed length — let the model
decide". Implementation: send **no override**; the Author agent's configured
`responseLimit` still applies as the `max_tokens` safety cap. We never send an uncapped
request (runaway-generation risk + unknown provider defaults). Default steps become
`[0, 100, 300, 500]`, with `0` labeled "Auto".

### 2. Hypothesis corpus

One checked-in data file (e.g. `src/data/format-hypotheses.json`) distilled from ST/KAI
presets, the LLM Settings Guide, and our own probe findings: candidate thinking tags, stop
tokens, kwarg keys (`enable_thinking` / `thinking` / `thinking_budget` /
`preserve_thinking` / `clear_thinking`), family regexes. Every entry carries its source.

### 3. Probe engine (library, not yet a job)

Productize the probe scripts into `src/inference/format-probe.ts`. Per (provider, model),
run a small matrix of cheap streaming calls — n≥2 per condition, sequential (concurrency
courtesy), each condition with a control:

- Which delta field carries reasoning (`reasoning` vs `reasoning_content` vs none).
- Inline thinking-tag variant, if any (checked against the corpus, not just `<think>`).
- Kwarg honoring, both directions: does thinking-off actually suppress; does thinking-on
  actually produce reasoning; is `thinking_budget` respected.
- Stop-token leakage (corpus catalog scan of outputs).
- Basic sanity: does a trivial prompt yield coherent output at all (detects a broken
  server-side template → model gets flagged unusable rather than "configured").
- `finish_reason` reliability (present/meaningful — the fold fix already leans on it).

Output: a `ModelFormatProfile` object + raw artifacts (same evidence discipline as
`data/experiments/`).

### 4. Profile storage + queue job

- Global-DB table keyed `(provider, model_id)` with profile JSON, `probedAt`, artifact path.
- New `model-probe` job type (jobs CHECK migration, established rename-aside pattern),
  visible in the Queue tab with per-condition progress labels.
- Triggers: agent saved with a model that has no profile → auto-enqueue; manual "Re-probe"
  button in the Agents tab. Probe holds concurrency slots for a while — accepted cost.
- Agents tab surfaces the profile summary (shape, toggles honored, leaks, probedAt).

### 5. Consumers

- `ReasoningStreamSplitter` tag set and trace routing read confirmed tags from the profile
  (shape-based routing stays as the fallback for unprofiled models).
- Prefill decision (`isReasoningModel()` `/deepseek/i` check) replaced by profile data.
- Effort toggle becomes per-model-aware: hidden or warned when the profile says the model
  ignores the toggle (Kimi) or cannot think (Gemma); `thinking_budget` offered only when
  verified honored.
- Retry rules and idle-timeout budget read the profile where they currently guess.
- HF metadata (sync-hf-model-tags) folded into the same record.

### 6. Runtime tripwire

During normal generation, if the observed stream shape contradicts the stored profile
(reasoning field appears that shouldn't, unknown tag variant, stop-token leak), flag the
model in the Agents tab ("format drift detected — re-probe suggested") and log the evidence.
This is the staleness answer to silent redeploys. Optionally auto-enqueue a re-probe.

## Parked (explicitly out of scope)

- **Cache/persistent-error mystery** ("errors persist even after buggy output is removed").
  No repro exists; instant-junk reflex means no captured evidence. Prerequisite when picked
  up: evidence capture — persist raw request+response (SSE included) for recent
  generations, plus a "this was garbage" snapshot affordance before retry. cache-hunter's
  MITM approach doesn't apply (can't interpose on Featherless); its latency-forensics idea
  could be adapted to our outbound-request logs.
- **Raw `/completions` escape hatch** with client-side templates — the only future where
  ST/KAI presets would be _applied_ rather than mined. Only worth it if a model's
  server-side template is confirmed broken and the model is worth keeping anyway.
- **Mood/param/model toggles** — still disabled pending preset tuning; unrelated to format
  probing.
