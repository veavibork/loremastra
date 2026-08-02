# Fold compression tuning (2026-08-02)

**Status: decided.** `FOLD_TARGET_RATIO` lowered from `0.5` to `0.2`; a new `foldCeilingTokens`
ties the API's real `maxTokens` for a fold call to the instructed target instead of the flat
Editor `responseLimit`. Both shipped in `src/services/story-to-date/engine.ts` /
`fold-worker.ts`. Revisit here if quality or length complaints resurface.

## Problem

After the fold-tier redesign (append vs. shrink, see `docs/providers/...` git history same day),
the user reported folding felt like "basically just concatenating the segments" — three real
fold-tier segments sat at 4469 / 3593 / 2169 tokens for spans of 245 / 172 / 163 posts
respectively (~18–21 tokens/post), against a recollection of "5 tokens per post" from earlier in
the project.

## Root cause: the model was obeying the prompt, not ignoring it

VM telemetry for a real fold call: `inputTokens=6379, outputTokens=2169` — **~34% output/input**,
almost exactly `FOLD_TARGET_RATIO` (0.5) applied to the merged input's word count. This mattered:
the framing going in was "the model won't compress enough," but the model was doing close to
what it was told. The instructed target itself just wasn't aggressive enough, and — separately —
nothing tied the API's real `maxTokens` to that target at all; the call always sent the full
`editor.responseLimit` (e.g. 4096), so even a model that wanted to write far more than instructed
had room to do so without ever being cut off.

## Experiment

Built `scripts/story-to-date-fold-tuning-ab.ts` — runs the real production `selectFoldSet` /
`selectFoldBatch` / `buildFoldSystem` against a live-synced VM save (`data/vm-sync`, story
`019fa8c7`), so every arm sees the exact batch a real fold job would. Two independent levers,
run **serially** (never in parallel — established project convention for these harnesses):

- **ratio**: the "aim for about N words" instruction's ratio (production default was 0.5)
- **ceiling**: the API's `maxTokens` param (production default was the flat `responseLimit`)

Batch tested: 4 segments (seqs 51–54), merged 1044 words / ~1636 tokens. Model: production live
Editor at the time, `deepseek-ai/DeepSeek-V4-Pro` (temp=1, responseLimit=4096).

| Arm                             | Ratio | Ceiling sent       | Target words  | Output words | Output/input | finish_reason |
| ------------------------------- | ----- | ------------------ | ------------- | ------------ | ------------ | ------------- |
| a (baseline)                    | 0.5   | 4096 (full)        | 522           | 701          | 68.3%        | stop          |
| b (tight ratio)                 | 0.2   | 4096 (full)        | 209           | 313          | 30.9%        | stop          |
| c (tight ceiling)               | 0.5   | 1018 (1.3x target) | 522           | 560          | 57.2%        | stop          |
| d (both)                        | 0.2   | 409 (1.3x target)  | 209           | 260          | 25.4%        | stop          |
| e (very tight, 200-word floor)  | 0.1   | 4096 (full)        | 200 (floored) | 248          | 24.6%        | stop          |
| e2 (very tight, 100-word floor) | 0.1   | 4096 (full)        | 104           | 176          | 17.7%        | stop          |

**Nothing ever hit the ceiling** — every arm finished via `finish_reason: "stop"`, including arm
d's tight 409-token cap. This experiment couldn't prove the ceiling lever's enforcement value
directly (it was never needed against this batch) — but the earlier live incident (a 3-segment
merge that wrote 2.7x its target and got flagged as truncated) is independent, real proof that
unconstrained overshoot does happen. **The ratio lever's effect is unambiguous**: 0.5→0.2 roughly
halved output even with an unlimited ceiling.

### The 200-word floor was masking ratio 0.1

`foldDigestTargetWords` floors the target at 200 words regardless of ratio. For this batch
(1044 words), `1044 × 0.1 = 104` — floored up to 200, identical to ratio 0.2's un-floored target
(209). That's why arm e's output (248 words) looked barely different from arm b/d (313/260) —
not because 0.1 "doesn't help," but because the floor silently capped it. Re-run with the floor
temporarily lowered to 100 (arm e2): target dropped to 104 words as expected, output 176 words
(17.7% — a real, further reduction).

### Quality check: 0.2 held up, 0.1 didn't

Read all digests for dropped/altered facts (the entire reason this pipeline exists):

- **Ratio 0.2** (arms b and d, two independent samples): both preserved every load-bearing fact —
  character names/traits, the causal beats, the relationship-test scene's core Q&A — while
  cutting scene color (exact dialogue, physical description). Nothing looked lossy.
- **Ratio 0.1, floor un-masked** (arm e2): real degradation in a single sample —
  - A **wrong fact**: claimed Rusty (the orange tom who bit Kit's phone) "stabilized in
    [Captain's] presence," merging him with Sidewinder — the source and every other arm
    distinguish Rusty as the agitated one, only Sidewinder stabilized.
  - **Dropped**: the "passed the audit by sitting still rather than performing" detail (recurs
    as a character pattern elsewhere in the story — more load-bearing than average color) and the
    Fisher King's dreamspace-meeting resolution.

n=1 at temp=1 isn't proof on its own (this project's standing finding: don't trust single trials
at high temperature), but combined with the floor-masked arm e's own borderline error (a different
wrong attribution, Delphine instead of Captain, in that earlier sample), 0.1 is past the point
this batch can compress without real cost. 0.2 is the tightest setting that came back clean twice.

## Decision

- `FOLD_TARGET_RATIO`: `0.5` → **`0.2`** (`engine.ts`).
- New `foldCeilingTokens(targetWords, responseLimit)`: real per-call `maxTokens`, computed from
  the target with a `FOLD_CEILING_MULTIPLIER` (1.3) headroom, clamped to `responseLimit`. Wired
  into `fold-worker.ts` in place of the flat `editor.responseLimit`. The truncation-rejection
  checks (`finishReason === 'length'`, `looksFoldDigestTruncated`) now check against this real
  per-call ceiling instead of the flat model limit, so they stay meaningful once the ceiling is
  actually tight.
- 200-word floor left as-is in production (`foldDigestTargetWords`) — only lowered locally for
  this experiment. Revisit together if a future batch needs to go below what 0.2 achieves.

## Reusable artifacts

- `scripts/story-to-date-fold-tuning-ab.ts` — the harness; add new arms to `ALL_ARMS` rather than
  forking the file. Note it hardcodes `EXPERIMENT_MIN_WORDS = 100` for the floor-masking
  re-test — restore to the real 200 (or parameterize) before reusing for a non-floor experiment.
- `data/experiments/fold-tuning-ab/<timestamp>/` — each run's raw digests + `summary.jsonl`.
