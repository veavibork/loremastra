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

### 1. Length toggle re-enable (independent, ships first) — ✅ done 2026-07-19 (5a8291a)

Re-enable the composer length toggle (`web/src/components/StoryToggles.tsx` — wiring is
commented out in `generationOptionsFull`) and honor `options.responseLimit` in
`applyGenerationOptions` (`src/queue/executors/prose.ts`), overriding
`profile.responseLimit` → `max_tokens`.

**"0" semantics (agreed 2026-07-19):** a `0` step means "no fixed length — let the model
decide". Implementation: send **no override**; the Author agent's configured
`responseLimit` still applies as the `max_tokens` safety cap. We never send an uncapped
request (runaway-generation risk + unknown provider defaults). Default steps become
`[0, 100, 300, 500]`, with `0` labeled "Auto".

### 2. Hypothesis corpus — ✅ done 2026-07-19

Shipped as `src/data/format-hypotheses.ts` (typed data module instead of JSON — no
`resolveJsonModule` churn) with tests in `tests/services/format-hypotheses.test.ts`.
Mined from: SillyTavern release-branch instruct + reasoning presets, KoboldAI Lite's
`instructpresets` + `hardcoded_think_closers` (extracted from the single-file app), the
LLM Settings Guide local snapshot (`Desktop/reference/llm-settings-guide.md`), the
Featherless kwargs docs, and our probe findings. Contents: 6 thinking-tag candidates
(incl. Gemma 4's `<|channel>thought`/`<channel|>` with a source spelling conflict noted,
Harmony channels, Seed/Cohere/Kimi variants), 29 leak tokens (eos + role-marker kinds;
DeepSeek's fullwidth `<｜end▁of▁sentence｜>` flagged as grep-hostile; `[INST]` flagged
probe-only due to bracket-note collision), 5 kwarg keys, 5 prompt-level thinking controls
(`/no_think`, `/nothink`, closed/empty/open `<think>` prefills), and 18 ordered family
regexes (`familyForModelId`, first-match-wins, Hermes before Llama). Helper
`allLeakScanTokens()` unions leak tokens + all tag markers for completion scanning.
Notable extras discovered: KAI's own runtime close-tag list (`</think>`, `<channel|>`,
`</seed:think>`, `<|END_THINKING|>`) corroborates the tag families.

### 3. Probe engine (library, not yet a job) — ✅ done 2026-07-19

Shipped as `src/inference/format-probe.ts` (pure analysis functions unit-tested in
`tests/services/format-probe.test.ts`; manual harness `scripts/format-probe.ts`).
Condition matrix: baseline (no kwargs), thinking-off, thinking-on, thinking-budget(64) —
n≥2 each, sequential, with 429/500/503 status-aware retry (429 waits 45s per the test-kit
gotcha). Artifacts (raw SSE, truncated observations, profile) written when an artifact dir
is given.

**Validation run (Qwen/Qwen3-8B, live, 8/8 calls):** matched the 2026-07-17 ground truth
AND found two new things. (1) **Shape is per-condition, not per-model** — with no kwargs
Qwen3-8B streams inline `<think>` in `content` (shape B, what the 7/17 probe saw), but
with explicit `enable_thinking: true` the reasoning moves to the separate `reasoning`
field (shape A). The profile now records `shapeByCondition`; consumers must read the
condition matching how they call (production always sends kwargs via
resolveChatTemplateKwargs). (2) **`thinking_budget` is ignored on Qwen3-8B via
Featherless** — budget=64 produced MORE reasoning than unbounded and one run burned the
whole max_tokens still thinking (`finish_reason: length`).

Original scope, all implemented:

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

### 4. Profile storage + probe runner — ✅ done 2026-07-19

**Design deviation from the original sketch:** no `model-probe` job type in the jobs table.
Jobs are story-scoped (each story DB has its own `jobs` table and every job must target a
text/segment in that story) — a model probe is global and has neither. Instead:

- `model_format_profiles` table in the **global** DB keyed `(provider, model_id)`, which is
  both the stored profile AND its own probe queue (status pending/running/done/failed/
  cancelled). Store: `src/db/model-format-profile-store.ts`. Re-probing keeps the last good
  `profile_json` until the new probe succeeds; failure/cancel also keeps it (stale truth
  beats no truth). Startup re-pends rows a dead process left 'running'.
- `src/queue/probe-runner.ts` — the global counterpart to dispatch.ts: 2s scan, single
  probe in flight process-wide, reserves Featherless slots through the same `slots.ts`
  gate (holder shows as `model-probe` in the Queue tab), slot cost from the model's
  `model_configs.concurrency_cost` when known. Abort path releases the slot immediately;
  the Queue tab panic button also aborts running probes.
- Routes: `GET /api/model-profiles` (list + live per-condition progress label),
  `POST /probe`, `POST /cancel` — POST bodies, not path params (model ids contain `/`).
- Triggers: Featherless config PATCHed with a never-probed model → auto-enqueue (refreshing
  a stale profile stays the explicit Re-probe button's job); "Probe format"/"Re-probe"/
  "Cancel" per card in the Agents tab, with a chip summary (shape, field/tag, kwargs
  honored, leaks, sanity, probed date). Active probes also render in the Queue tab.

**Smoke-tested live** against the dev server via a direct-DB enqueue: full loop ran
(claim → slot hold → 8 sequential calls → artifacts → finish). The run also caught a real
bug — all calls failing (stale local API key, HTTP 401) still stored a `done` profile with
an authoritative-looking `none-observed` shape. Fixed: zero successful calls → status
`failed` with the first HTTP error preserved. (The local dev DB's stored Featherless key
differs from `.env`'s working one — probes on the VM use the real stored key.)

### 5. Consumers — ✅ done 2026-07-19

All decisions live in `src/services/model-format.ts` as pure `*For(profile, …)` cores
(unit-tested) with thin global-DB wrappers; unprofiled models fall back to exactly the
pre-probe heuristics, so behavior only changes where a probe produced evidence.

- **Splitter tags**: `ReasoningStreamSplitter` accepts custom open/close tag lists; the
  hardcoded `<think>` pair always stays, plus the model's probe-confirmed variant
  (`splitterTagsForModel`). Shape-based routing unchanged as the safety net.
- **Prefill decision**: `shouldPrefillThink` — never prefill unless resolved kwargs
  explicitly enable thinking; deepseek family only (profile `family`, `/deepseek/i`
  fallback); suppressed when the probe says the model can't think. Expanding beyond
  deepseek needs its own A/B evidence — the empty-completion coin flip is stochastic, a
  probe can't measure it. **Bug found & fixed on the way:** prose.ts force-passed prefill
  for `/deepseek/i` models unconditionally, bypassing the effort-off guard.
  Live-validated on DeepSeek-V4-Pro (2×3 conditions): off+no-prefill clean, on+prefill
  reasoning-in-field + full prose; the old off+prefill combo happened to stream clean on
  V4-Pro, so no live breakage preceded the fix.
- **Idle timeout**: profile-aware in two directions — thinking requested but model can't
  think → short budget; thinking off but model ignores the off switch (Kimi-style) → long
  budget.
- **Effort toggle per-model-aware**: the composer Effort label itself carries the caveat
  ("(no effect)" / "(thinks anyway)" / "(budget ignored)") for the primary Author model —
  label text, not a tooltip, because tablet. Button stays functional (warn, not hide).
- **HF metadata**: `GET /api/model-profiles` enriches each row with `hfTags` from the
  offline cache at read time; shown as a muted chip in the Agents card.
- **Deliberately unchanged**: the empty-completion retry rules stay shape-based (they were
  already evidence-driven), and `stripThinkingTags` (non-streamed completeChat/callWithTools
  callers) keeps the hardcoded `<think>` pair — its call sites are Worker/Editor paths where
  the profile isn't threaded through yet; fold in if a non-`<think>` model ever lands there.

### 6. Runtime tripwire — ✅ done 2026-07-19

After every successful `streamWithFallback` stream, `reportFormatDrift`
(src/services/model-format.ts) compares what actually happened against the stored profile.
Deliberately one-sided: only "something appeared that the profile says shouldn't" flags —
the absence of reasoning proves nothing (models legitimately skip thinking on easy turns).
Checks:

- reasoning appeared (field or inline) with thinking off, when the profile says the off
  switch suppresses it;
- a separate reasoning delta field the probe never observed;
- inline thinking tags the probe never observed;
- a template-token leak not already in `profile.leakTokensSeen` — scanned with
  `runtimeLeakScanTokens()`, which excludes probe-only tokens (`[INST]` collides with
  bracket-note prose; the corpus now carries a `runtimeScan: false` flag).

First detection wins: drift columns on the profile row store the timestamp + reasons, later
contradictions only log (telemetry `jobType: 'format-drift'`, with evidence). A successful
re-probe clears the flag; a failed one keeps it. Agents tab shows a red wrapping chip
("drift <date>: <reason> — re-probe suggested") next to the existing Re-probe button. The
tripwire is wrapped so it can never fail a generation that already succeeded.

**Deliberately not auto-enqueueing a re-probe on drift** — a probe holds concurrency slots
for minutes and drift is detected mid-play; flag + one-tap Re-probe keeps the user in
control. Revisit if drift turns out to be frequent. Non-streamed Worker/Editor calls
(completeChat/callWithTools) are outside the tripwire for now, same boundary as the other
step-5 consumers.

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
